"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useAppContext } from "@/components/app-provider";
import { AppFooter, ProductBrand } from "@/components/product-brand";
import { AttendancePanelSkeleton, CardSectionSkeleton, FieldConsoleSkeleton, Skeleton } from "@/components/skeleton";
import { calculateHash } from "@/lib/crypto";
import { db } from "@/lib/db";
import { apiFetch } from "@/lib/env";
import {
  fieldMilestoneStepLabel,
  isLockedMilestoneStatus,
  isPaidCompletedMilestoneStatus,
  resolveCurrentFieldMilestone,
  sortMilestonesByOrder,
} from "@/lib/evidence-rules";
import {
  applyPendingAttendanceOverlay,
  discardSyncItem,
  enqueueAttendanceMark,
  readAttendanceCache,
  retrySyncItem,
  saveAttendanceCache,
} from "@/lib/sync-engine";
import {
  getDeviceId,
  getCurrentPosition,
  getLocalDateStringClient,
  formatDeviceDateTime,
  cloudinaryAvatarUrl,
  getInitials,
} from "@/lib/utils";
import { randomUUID } from "@/lib/crypto";
import type { LocalMediaRecord, LocalMilestone, LocalRecord, LocalRecordStatus } from "@/lib/types";

if (typeof window !== "undefined") {
  // Dev-only: expose db in console via window.__navadrishti_db if needed
  if (process.env.NODE_ENV === "development") {
    (window as unknown as { __navadrishti_db?: typeof db }).__navadrishti_db = db;
  }
}

function syncStatusLabel(status: LocalRecordStatus | string | null | undefined): string {
  switch (String(status || "").toLowerCase()) {
    case "pending":
      return "Saved locally";
    case "syncing":
      return "Uploading";
    case "synced":
      return "Uploaded";
    case "failed":
      return "Upload failed";
    default:
      return String(status || "Unknown");
  }
}

function syncStatusHint(status: LocalRecordStatus | string | null | undefined): string {
  switch (String(status || "").toLowerCase()) {
    case "pending":
      return "On this device — not yet confirmed by the server";
    case "syncing":
      return "Upload in progress while the app is open";
    case "synced":
      return "Server confirmed receipt. Review status is separate from upload.";
    case "failed":
      return "Upload failed. Retry while online, or discard and recapture.";
    default:
      return "";
  }
}

/** Inclusive day span when both campaign dates are present; otherwise null (no fake %). */
function assignmentDaySpan(item: { start_date?: string | null; end_date?: string | null }) {
  const start = String(item.start_date || "").slice(0, 10);
  const end = String(item.end_date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  const total = Math.floor((endMs - startMs) / 86_400_000) + 1;
  return total > 0 ? total : null;
}

function UserWelcomeNav({
  name,
  avatarUrl,
  connectivityReady,
  isOnline,
  isSyncing = false,
  pendingSyncCount = 0,
}: {
  name: string;
  avatarUrl?: string | null;
  connectivityReady: boolean;
  isOnline: boolean;
  isSyncing?: boolean;
  pendingSyncCount?: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const displayName = name.trim() || "User";
  const avatarSrc = avatarUrl && !imageFailed ? cloudinaryAvatarUrl(avatarUrl, 88) : null;
  const statusClass = !connectivityReady
    ? "is-checking"
    : isSyncing
      ? "is-syncing"
      : isOnline
        ? "is-online"
        : "is-offline";

  useEffect(() => {
    setImageFailed(false);
  }, [avatarUrl]);

  return (
    <section className="field-hub-welcome" aria-label="Welcome">
      <div className="field-hub-welcome-main">
        <div className="field-hub-avatar" aria-hidden="true">
          {avatarSrc ? (
            <img
              src={avatarSrc}
              alt=""
              className="field-hub-avatar-image"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <span className="field-hub-avatar-fallback">{getInitials(displayName)}</span>
          )}
          <span className={`field-hub-avatar-status ${statusClass}`} />
        </div>

        <div className="field-hub-welcome-copy">
          <p className="field-hub-welcome-label">Welcome</p>
          <p className="field-hub-welcome-name">{displayName}</p>
          <p className="field-hub-welcome-meta">
            {!connectivityReady
              ? "Checking connection…"
              : isSyncing
                ? "Uploading stored records…"
                : isOnline
                  ? "Online — sync runs while this app is open"
                  : "Offline — new records stay on this device"}
          </p>
        </div>
      </div>

      {pendingSyncCount > 0 ? (
        <span className="field-hub-sync-badge" aria-live="polite">
          {pendingSyncCount} waiting on this device — uploads only while the app stays open
        </span>
      ) : null}
    </section>
  );
}

export function FieldConsole() {
  const {
    session,
    sessionLoading,
    connectivityReady,
    isOnline,
    isSyncing,
    lastSync,
    signOut,
    syncNow,
  } = useAppContext();
  const [activeTab, setActiveTab] = useState<"evidence" | "attendance">("evidence");
  const [capturedBlobs, setCapturedBlobs] = useState<
    { blob: Blob; url: string; name: string; proofHash: string }[]
  >([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitState, setSubmitState] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [activePreviewUrl, setActivePreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    setDeviceId(getDeviceId());
  }, []);

  const canEvidence = session?.role === "ngo";
  const isIndividual = session?.role === "individual";
  /** NGO leads with no volunteer/skill assignments never see Attendance. */
  const [ngoAttendanceEligible, setNgoAttendanceEligible] = useState(false);
  const canAttendance = isIndividual || (canEvidence && ngoAttendanceEligible);

  useEffect(() => {
    if (isIndividual) setActiveTab("attendance");
    else setActiveTab("evidence");
  }, [isIndividual]);

  useEffect(() => {
    if (!canEvidence || !session?.id) {
      setNgoAttendanceEligible(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const countItems = (lists: {
        activeCampaigns?: unknown[];
        historyCampaigns?: unknown[];
        activeSkills?: unknown[];
        historySkills?: unknown[];
      }) => {
        const skills = [...(lists.activeSkills || []), ...(lists.historySkills || [])].filter(
          (item: any) => !item?.kind || item.kind === "skill_service"
        );
        return (
          (lists.activeCampaigns?.length || 0) +
          (lists.historyCampaigns?.length || 0) +
          skills.length
        );
      };
      try {
        const cached = await readAttendanceCache(session.id);
        if (!cancelled && cached && countItems(cached) > 0) setNgoAttendanceEligible(true);
        if (!navigator.onLine) return;
        const res = await apiFetch("/api/attendance/assignments");
        const data = await res.json();
        if (cancelled || !res.ok || !data?.ok) return;
        const active = data.data?.active || {};
        const history = data.data?.history || {};
        const lists = {
          activeCampaigns: active.campaignItems || data.data?.campaignItems || [],
          historyCampaigns: history.campaignItems || [],
          activeSkills: active.skillItems || data.data?.skillItems || [],
          historySkills: history.skillItems || [],
        };
        await saveAttendanceCache(session.id, lists);
        if (!cancelled) setNgoAttendanceEligible(countItems(lists) > 0);
      } catch {
        /* keep prior eligibility */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canEvidence, session?.id, isOnline]);

  useEffect(() => {
    if (!canAttendance && activeTab === "attendance") setActiveTab("evidence");
  }, [canAttendance, activeTab]);

  // Camera State
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [evidenceCoords, setEvidenceCoords] = useState<{
    latitude: number;
    longitude: number;
    accuracy: number | null;
  } | null>(null);
  const [evidenceLocating, setEvidenceLocating] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);

  // Shared Queries (Isolated by Logged-in User)
  const records = useLiveQuery(async () => {
    if (!session?.id) return [];
    const local = await db.recordsLocal
      .where("userId")
      .equals(session.id)
      .reverse()
      .toArray();
    const media = await db.mediaLocal.toArray();
    return local.map(r => ({ ...r, media: media.filter(m => m.recordId === r.id) }));
  }, [session?.id], []);

  const stats = useLiveQuery(async () => {
    if (!session?.id) {
      return { pending: 0, syncing: 0, failed: 0, synced: 0, mediaAwaitingUpload: 0 };
    }
    const all = await db.recordsLocal.where("userId").equals(session.id).toArray();
    const awaitingIds = all
      .filter((row) => row.status === "pending" || row.status === "syncing" || row.status === "failed")
      .map((record) => record.id);
    const mediaAwaitingUpload =
      awaitingIds.length === 0
        ? 0
        : await db.mediaLocal.where("recordId").anyOf(awaitingIds).count();
    return {
      pending: all.filter((r) => r.status === "pending").length,
      syncing: all.filter((r) => r.status === "syncing").length,
      failed: all.filter((r) => r.status === "failed").length,
      synced: all.filter((r) => r.status === "synced").length,
      mediaAwaitingUpload,
    };
  }, [session?.id], {
    pending: 0,
    syncing: 0,
    failed: 0,
    synced: 0,
    mediaAwaitingUpload: 0,
  });

  const milestoneOverview = useLiveQuery(async () => {
    const all = await db.milestones.toArray();
    const count = (status: string) =>
      all.filter((row) => String(row.status || "").toLowerCase() === status).length;
    return {
      total: all.length,
      open: count("pending") + count("rejected"),
      awaitingReview: count("submitted"),
      approved: count("approved"),
      completed: count("completed"),
      rejected: count("rejected"),
    };
  }, [], {
    total: 0,
    open: 0,
    awaitingReview: 0,
    approved: 0,
    completed: 0,
    rejected: 0,
  });

  const pendingSyncCount = useLiveQuery(async () => {
    if (!session?.id) return 0;
    const pendingStatuses = new Set(["pending", "syncing", "failed"]);
    const [records, outbox] = await Promise.all([
      db.recordsLocal.where("userId").equals(session.id).toArray(),
      db.attendanceOutbox.where("userId").equals(session.id).toArray(),
    ]);

    return (
      records.filter((row) => pendingStatuses.has(row.status)).length +
      outbox.filter((row) => pendingStatuses.has(row.status)).length
    );
  }, [session?.id], 0);

  const handleRetryRecord = async (recordId: string) => {
    if (!session) return;
    try {
      await retrySyncItem(recordId, session.id);
      setSubmitState({ tone: "success", message: "Record queued for retry." });
      if (isOnline) await syncNow();
    } catch (error) {
      setSubmitState({ tone: "error", message: error instanceof Error ? error.message : "Retry failed." });
    }
  };

  const handleDiscardRecord = async (recordId: string) => {
    if (!session || !window.confirm("Discard this unsynced record and its photos?")) return;
    try {
      await discardSyncItem(recordId, session.id);
      setSubmitState({ tone: "success", message: "Unsynced record discarded." });
    } catch (error) {
      setSubmitState({ tone: "error", message: error instanceof Error ? error.message : "Discard failed." });
    }
  };

  // Camera Controls
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraReady(false);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraLoading(true);
    setCameraError(null);
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (!videoRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      videoRef.current.srcObject = stream;
      streamRef.current = stream;
      setCameraReady(true);
    } catch (err) {
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      setCameraError(
        denied
          ? "Camera access was blocked. Allow camera access in your browser settings, then try again."
          : "The camera could not be opened. Close other apps using it and try again."
      );
    } finally {
      setCameraLoading(false);
    }
  }, [stopCamera]);

  const capturePhoto = async (contextLabel: string) => {
    if (!videoRef.current || !canvasRef.current || !cameraReady) return;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) return;

    let coords = evidenceCoords;
    if (!coords) {
      coords = await getCurrentPosition();
      if (coords) setEvidenceCoords(coords);
    }
    if (!coords) {
      setCameraError("Location is required. Enable GPS and try again.");
      return;
    }

    canvas.width = videoRef.current.videoWidth || 1280;
    canvas.height = videoRef.current.videoHeight || 720;
    context.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

    const stampTime = new Date().toLocaleString();
    const todayLabel = getLocalDateStringClient();
    const lat = coords.latitude.toFixed(6);
    const lng = coords.longitude.toFixed(6);
    context.fillStyle = "rgba(0,0,0,0.45)";
    context.fillRect(0, canvas.height - 110, canvas.width, 110);
    context.font = "bold 22px monospace";
    context.fillStyle = "#fde047";
    context.fillText(stampTime, 16, canvas.height - 72);
    context.fillText(`DATE ${todayLabel}`, 16, canvas.height - 44);
    context.fillText(`GPS ${lat}, ${lng}`, 16, canvas.height - 16);
    context.font = "16px monospace";
    context.fillText((contextLabel || "Evidence").slice(0, 42), 16, canvas.height - 96);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92)
    );
    if (!blob) {
      setCameraError("Could not seal photo.");
      return;
    }
    const proofHash = await calculateHash(blob);
    if (!/^[a-f0-9]{64}$/i.test(proofHash)) {
      setCameraError("Could not seal photo integrity hash.");
      return;
    }
    setCapturedBlobs((prev) => [
      ...prev,
      {
        blob,
        url: URL.createObjectURL(blob),
        name: `cap-${Date.now()}.jpg`,
        proofHash: proofHash.toLowerCase(),
      },
    ]);
    setCameraError(null);
  };

  useEffect(() => { return () => stopCamera(); }, [stopCamera]);

  useEffect(() => {
    if (activeTab === "attendance") stopCamera();
  }, [activeTab, stopCamera]);

  // Evidence view: lock GPS then auto-open camera (no manual Open Camera control).
  const showEvidenceCapture = canEvidence && (activeTab === "evidence" || !canAttendance);
  useEffect(() => {
    if (!showEvidenceCapture) return;
    let cancelled = false;
    (async () => {
      setEvidenceLocating(true);
      setCameraError(null);
      const position = await getCurrentPosition();
      if (cancelled) return;
      if (!position) {
        setEvidenceCoords(null);
        setEvidenceLocating(false);
        setCameraError("Location is required. Enable GPS and try again.");
        return;
      }
      setEvidenceCoords(position);
      setEvidenceLocating(false);
      await startCamera();
    })();
    return () => {
      cancelled = true;
    };
  }, [showEvidenceCapture, startCamera]);

  const capturedUrlsRef = useRef<string[]>([]);
  capturedUrlsRef.current = capturedBlobs.map((item) => item.url);
  useEffect(() => () => capturedUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const removeCapturedPhoto = (index: number) => {
    setCapturedBlobs((current) => {
      const removed = current[index];
      if (removed) URL.revokeObjectURL(removed.url);
      return current.filter((_, i) => i !== index);
    });
  };

  // Main Submit Logic
  async function handleSeal(data: {
    beneficiaryName: string | null;
    interactionType: string;
    notes: string;
    projectId: string | null;
    projectName: string;
    milestoneId: string | null;
    referencePointId: string | null;
  }) {
    if (!session) return;
    setSubmitting(true);
    setSubmitState(null);

    try {
      const resolvedDeviceId = deviceId || getDeviceId();
      if (!deviceId) setDeviceId(resolvedDeviceId);

      const coords = evidenceCoords || (await getCurrentPosition());
      if (!coords) throw new Error("Could not acquire GPS signal. Check permissions.");
      if (!evidenceCoords) setEvidenceCoords(coords);

      const recordId = randomUUID();
      const createdAt = new Date().toISOString();

      const mediaEntries: LocalMediaRecord[] = [];
      for (const item of capturedBlobs) {
        const sealedHash = String(item.proofHash || "").toLowerCase();
        const actualHash = (await calculateHash(item.blob)).toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(sealedHash) || sealedHash !== actualHash) {
          throw new Error("Photo integrity check failed. Recapture and try again.");
        }
        mediaEntries.push({
          id: randomUUID(),
          recordId,
          fileName: item.name,
          mimeType: item.blob.type || "image/jpeg",
          size: item.blob.size,
          kind: "image",
          blob: item.blob,
          proofHash: sealedHash,
          createdAt,
        });
      }

      const record: LocalRecord = {
        id: recordId,
        deviceId: resolvedDeviceId,
        userId: session.id,
        userName: session.name,
        projectId: data.projectId,
        projectName: data.projectName,
        milestoneId: data.milestoneId,
        referencePointId: data.referencePointId,
        userType: "ngo",
        beneficiaryName: data.beneficiaryName,
        interactionType: data.interactionType as LocalRecord["interactionType"],
        notes: data.notes,
        gpsLat: coords.latitude,
        gpsLng: coords.longitude,
        status: "pending",
        createdAtDevice: createdAt,
        submittedAtDevice: createdAt,
        syncedAt: null,
        lastError: null,
      };

      await db.transaction("rw", [db.recordsLocal, db.mediaLocal, db.syncQueue, db.milestones], async () => {
        await db.recordsLocal.add(record);
        await db.mediaLocal.bulkAdd(mediaEntries);
        await db.syncQueue.put({
          id: recordId,
          recordId,
          userId: session.id,
          kind: "evidence",
          status: "pending",
          attempts: 0,
          nextAttemptAt: Date.now(),
          lastError: null,
          createdAt,
          updatedAt: createdAt,
        });
        if (data.milestoneId) {
          await db.milestones.update(data.milestoneId, { status: "submitted", updatedAt: createdAt });
        }
      });

      capturedBlobs.forEach((item) => URL.revokeObjectURL(item.url));
      setCapturedBlobs([]);
      setSubmitState({
        tone: "success",
        message: isOnline
          ? "Evidence saved on this device. Upload runs while the app stays open and online."
          : "Evidence saved on this device. It will upload when the app is open and online.",
      });
      if (isOnline) await syncNow();
    } catch (error) {
      setSubmitState({ tone: "error", message: error instanceof Error ? error.message : "Submission failed." });
    } finally {
      setSubmitting(false);
    }
  }

  if (sessionLoading) return <FieldConsoleSkeleton />;

  const statsLoading = stats === undefined;
  const recordsLoading = records === undefined;
  const showHubTabs = canEvidence && canAttendance;
  const showAttendance = canAttendance && (activeTab === "attendance" || !canEvidence);

  return (
    <main className="app field-hub">
      <header className="app-header field-hub-header">
        <ProductBrand size="sm" className="header-brand field-hub-brand-only" />
        <div className="field-hub-actions">
          {!showAttendance ? (
            <button type="button" className="btn-outline" onClick={() => void syncNow()} disabled={!isOnline || isSyncing}>
              Sync
            </button>
          ) : null}
          <button type="button" className="btn-outline" onClick={signOut}>Sign Out</button>
        </div>
      </header>

      <UserWelcomeNav
        name={session?.ngoName || session?.name || "User"}
        avatarUrl={session?.avatarUrl}
        connectivityReady={connectivityReady}
        isOnline={isOnline}
        isSyncing={isSyncing}
        pendingSyncCount={pendingSyncCount}
      />

      {lastSync?.authExpired ? (
        <div className="form-error" role="alert" style={{ margin: "0 16px" }}>
          Your session has expired. Sign out and sign in again to upload the items waiting on this device.
        </div>
      ) : null}

      {showHubTabs ? (
        <nav className="field-hub-tabs" aria-label="App sections">
          <button
            type="button"
            className={activeTab === "evidence" ? "is-active" : ""}
            onClick={() => setActiveTab("evidence")}
          >
            Evidence
          </button>
          <button
            type="button"
            className={activeTab === "attendance" ? "is-active" : ""}
            onClick={() => setActiveTab("attendance")}
          >
            Attendance
          </button>
        </nav>
      ) : null}

      <div className="field-hub-body">
      {showAttendance ? (
        <AttendancePanel showSkillSection />
      ) : (
        <>
          <section className="card-section field-overview" aria-label="Field overview">
            <span className="section-title">Overview</span>
            <p className="field-overview-copy">
              Evidence is sealed on this device first. Upload confirmation is not the same as milestone
              review or approval.
            </p>
            <div className="chips-row">
              {statsLoading ? (
                <>
                  <Skeleton className="skeleton-chip" />
                  <Skeleton className="skeleton-chip" />
                  <Skeleton className="skeleton-chip" />
                </>
              ) : (
                <>
                  <div className="chip">
                    <div
                      className={`chip-dot ${
                        !connectivityReady
                          ? "dot-checking"
                          : isSyncing
                            ? "dot-syncing"
                            : isOnline
                              ? "dot-online"
                              : "dot-offline"
                      }`}
                    />
                    {!connectivityReady
                      ? "Checking…"
                      : isSyncing
                        ? "Uploading…"
                        : isOnline
                          ? "Online"
                          : "Offline — local only"}
                  </div>
                  <div className="chip" title="Saved locally — waiting to upload">
                    <span className="badge badge-slate">Local queue</span>{" "}
                    {stats.pending + stats.syncing}
                  </div>
                  <div className="chip" title="Upload failed — needs retry or discard">
                    <span className="badge badge-amber">Failed</span> {stats.failed}
                  </div>
                  <div className="chip" title="Server confirmed upload">
                    <span className="badge badge-blue">Uploaded</span> {stats.synced}
                  </div>
                  <div className="chip" title="Local photo blobs still waiting to upload">
                    <span className="badge badge-slate">Photos queued</span> {stats.mediaAwaitingUpload}
                  </div>
                </>
              )}
            </div>

            {milestoneOverview.total > 0 ? (
              <div className="field-overview-milestones" aria-label="Milestone review status">
                <div className="field-overview-stat">
                  <strong>{milestoneOverview.open}</strong>
                  <span>Open / redo</span>
                </div>
                <div className="field-overview-stat">
                  <strong>{milestoneOverview.awaitingReview}</strong>
                  <span>Awaiting review</span>
                </div>
                <div className="field-overview-stat">
                  <strong>{milestoneOverview.approved}</strong>
                  <span>Approved</span>
                </div>
                <div className="field-overview-stat">
                  <strong>{milestoneOverview.rejected}</strong>
                  <span>Rejected</span>
                </div>
              </div>
            ) : (
              <p className="field-overview-empty">
                No project milestones on this device yet. Sync while online to refresh assignments.
              </p>
            )}

            {stats.failed > 0 ? (
              <p className="field-overview-attention" role="status">
                {stats.failed} evidence record{stats.failed === 1 ? "" : "s"} need attention below.
              </p>
            ) : null}
          </section>

          <NgoCaptureView
            onSeal={handleSeal}
            submitting={submitting}
            submitState={submitState}
            capturedBlobs={capturedBlobs}
            onRemovePhoto={removeCapturedPhoto}
            cameraReady={cameraReady}
            cameraLoading={cameraLoading}
            cameraError={cameraError}
            evidenceCoords={evidenceCoords}
            evidenceLocating={evidenceLocating}
            startCamera={startCamera}
            stopCamera={stopCamera}
            capturePhoto={capturePhoto}
            videoRef={videoRef}
            canvasRef={canvasRef}
            onPreviewImage={setActivePreviewUrl}
          />

          <section className="card-section">
            <span className="section-title">Recent device history</span>
            <p className="field-overview-copy">
              Status below is upload state on this device, not platform approval.
            </p>
            <div style={{ display: "grid", gap: "8px" }}>
              {recordsLoading ? (
                <>
                  <Skeleton className="skeleton-ledger" />
                  <Skeleton className="skeleton-ledger" />
                  <Skeleton className="skeleton-ledger" />
                </>
              ) : records.length === 0 ? (
                <p className="field-empty-state">
                  No evidence sealed on this device yet. Capture photos and submit to create a local record.
                </p>
              ) : (
                records.slice(0, 8).map((r) => (
                  <div key={r.id} className="ledger-item" style={{ flexDirection: "column", alignItems: "stretch" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                      <div className="ledger-info">
                        <div className="ledger-title">{r.beneficiaryName || "Evidence record"}</div>
                        <div className="ledger-meta">
                          {r.projectName} · {formatDeviceDateTime(r.submittedAtDevice)}
                        </div>
                        <div className="ledger-meta">{syncStatusHint(r.status)}</div>
                      </div>
                      <div className={`status-badge status-${r.status}`} title={syncStatusHint(r.status)}>
                        {syncStatusLabel(r.status)}
                      </div>
                    </div>
                    {r.media.length > 0 ? (
                      <LedgerItemMedia media={r.media} onPreview={setActivePreviewUrl} />
                    ) : r.status === "synced" ? (
                      <p className="ledger-meta" style={{ marginTop: 6 }}>
                        Local photos removed after server confirmation.
                      </p>
                    ) : null}
                    {r.status === "failed" ? (
                      <div className="ledger-actions">
                        <span className="ledger-meta">{r.lastError || "Sync failed."}</span>
                        <button type="button" className="btn-outline" onClick={() => void handleRetryRecord(r.id)}>
                          Retry
                        </button>
                        <button type="button" className="btn-outline" onClick={() => void handleDiscardRecord(r.id)}>
                          Discard
                        </button>
                      </div>
                    ) : r.status === "pending" || r.status === "syncing" ? (
                      <p className="ledger-meta" style={{ marginTop: 6 }}>
                        Waiting to upload — keep the app open while online.
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
      </div>

      {activePreviewUrl && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
            backdropFilter: "blur(8px)",
            cursor: "zoom-out",
          }}
          onClick={() => setActivePreviewUrl(null)}
        >
          <div style={{ position: "relative", maxWidth: "90%", maxHeight: "90%" }} onClick={(e) => e.stopPropagation()}>
            <img
              src={activePreviewUrl}
              style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain", borderRadius: "var(--radius-md)", border: "2px solid rgba(255,255,255,0.2)" }}
              alt="Full Preview"
            />
            <button
              type="button"
              onClick={() => setActivePreviewUrl(null)}
              style={{
                position: "absolute",
                top: "-45px",
                right: "0",
                background: "#fff",
                color: "#000",
                fontWeight: "bold",
                fontSize: "0.8rem",
                padding: "6px 14px",
                borderRadius: "8px",
                border: "none",
                cursor: "pointer",
                boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
      <AppFooter />
    </main>
  );
}

function AttendancePanel({ showSkillSection = true }: { showSkillSection?: boolean }) {
  const { session, connectivityReady, isOnline, isSyncing, syncNow } = useAppContext();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<"active" | "history">("active");
  const [activeCampaigns, setActiveCampaigns] = useState<any[]>([]);
  const [historyCampaigns, setHistoryCampaigns] = useState<any[]>([]);
  const [activeSkills, setActiveSkills] = useState<any[]>([]);
  const [historySkills, setHistorySkills] = useState<any[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [captureTarget, setCaptureTarget] = useState<{
    item: any;
    mode: "selfie" | "photo";
  } | null>(null);
  const failedAttendance = useLiveQuery(
    async () =>
      session?.id
        ? db.attendanceOutbox
            .where("userId")
            .equals(session.id)
            .filter((row) => row.status === "failed")
            .toArray()
        : [],
    [session?.id],
    []
  );
  const pendingAttendance = useLiveQuery(
    async () =>
      session?.id
        ? db.attendanceOutbox
            .where("userId")
            .equals(session.id)
            .filter((row) => row.status === "pending" || row.status === "syncing")
            .toArray()
        : [],
    [session?.id],
    []
  );

  const load = useCallback(async () => {
    if (!session?.id) return;
    setLoading(true);
    setError(null);
    try {
      let lists = {
        activeCampaigns: [] as any[],
        historyCampaigns: [] as any[],
        activeSkills: [] as any[],
        historySkills: [] as any[],
      };

      if (navigator.onLine) {
        const res = await apiFetch("/api/attendance/assignments");
        const data = await res.json();
        if (!res.ok || !data?.ok) throw new Error(data?.error || "Failed to load attendance");

        const active = data.data?.active;
        const history = data.data?.history;

        lists = {
          activeCampaigns: Array.isArray(active?.campaignItems)
            ? active.campaignItems
            : Array.isArray(data.data?.campaignItems)
              ? data.data.campaignItems
              : [],
          historyCampaigns: Array.isArray(history?.campaignItems) ? history.campaignItems : [],
          activeSkills: Array.isArray(active?.skillItems)
            ? active.skillItems
            : Array.isArray(data.data?.skillItems)
              ? data.data.skillItems
              : [],
          historySkills: Array.isArray(history?.skillItems) ? history.skillItems : [],
        };

        await saveAttendanceCache(session.id, lists);
      } else {
        const cached = await readAttendanceCache(session.id);
        if (!cached) {
          throw new Error(
            "No saved attendance list on this device yet. Go online once to download your assignments."
          );
        }
        lists = {
          activeCampaigns: cached.activeCampaigns || [],
          historyCampaigns: cached.historyCampaigns || [],
          activeSkills: cached.activeSkills || [],
          historySkills: cached.historySkills || [],
        };
      }

      const withPending = await applyPendingAttendanceOverlay(session.id, lists);
      setActiveCampaigns(withPending.activeCampaigns);
      setHistoryCampaigns(withPending.historyCampaigns);
      setActiveSkills(withPending.activeSkills);
      setHistorySkills(withPending.historySkills);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load attendance");
    } finally {
      setLoading(false);
    }
  }, [session?.id]);

  useEffect(() => {
    void load();
  }, [load, isOnline]);

  const campaignItems = bucket === "active" ? activeCampaigns : historyCampaigns;
  const skillItems = (bucket === "active" ? activeSkills : historySkills).filter(
    (item) => item.kind === "skill_service"
  );
  const activeSkillCount = activeSkills.filter((item) => item.kind === "skill_service").length;
  const historySkillCount = historySkills.filter((item) => item.kind === "skill_service").length;
  const isHistory = bucket === "history";
  const hasCampaignSection = campaignItems.length > 0;
  const hasSkillSection = showSkillSection && skillItems.length > 0;
  const totalActive = activeCampaigns.length + activeSkillCount;
  const totalHistory = historyCampaigns.length + historySkillCount;

  const markedToday = (summary: any) =>
    String(summary?.last_attendance_at || "") === getLocalDateStringClient();
  const daysPresent = (summary: any) =>
    Number(summary?.days_attended ?? summary?.total_entries ?? 0);
  const volunteerCount = (item: any) => Math.max(1, Number(item.volunteer_capacity) || 1);
  const todayLabel = getLocalDateStringClient();
  const markedTodayCount = [...activeCampaigns, ...activeSkills].filter((item) =>
    markedToday(item.attendance_summary)
  ).length;
  const pendingSyncLocal = pendingAttendance?.length || 0;
  const failedLocal = failedAttendance?.length || 0;

  function openCapture(item: any, mode: "selfie" | "photo") {
    if (!item.assignment_id || !item.can_mark) return;
    if (markedToday(item.attendance_summary)) {
      setMessage(
        item.attendance_summary?.pending_sync
          ? "Today's attendance is saved on this device and will upload while the app stays open and online."
          : "Today's attendance is already marked on the server and cannot be changed."
      );
      return;
    }
    setMessage(null);
    setCaptureTarget({ item, mode });
  }

  async function retryAttendance(id: string) {
    if (!session) return;
    try {
      await retrySyncItem(id, session.id);
      setMessage("Attendance queued for retry.");
      if (isOnline) await syncNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not retry attendance.");
    }
  }

  async function discardAttendance(id: string) {
    if (!session || !window.confirm("Discard this unsynced attendance mark and its photos?")) return;
    try {
      await discardSyncItem(id, session.id);
      setMessage("Unsynced attendance was discarded.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not discard attendance.");
    }
  }

  if (loading) {
    return <AttendancePanelSkeleton showSkillSection={showSkillSection} />;
  }

  return (
    <div className="attendance-console">
      <section className="card-section field-overview" aria-label="Attendance overview">
        <span className="section-title">Overview</span>
        <p className="field-overview-copy">
          Attendance day {todayLabel} (IST). Marks save on this device first; server confirmation is
          separate from a local pending upload.
        </p>
        <div className="field-overview-milestones">
          <div className="field-overview-stat">
            <strong>{totalActive}</strong>
            <span>Active assignments</span>
          </div>
          <div className="field-overview-stat">
            <strong>{markedTodayCount}</strong>
            <span>Marked today</span>
          </div>
          <div className="field-overview-stat">
            <strong>{pendingSyncLocal}</strong>
            <span>Waiting to upload</span>
          </div>
          <div className="field-overview-stat">
            <strong>{failedLocal}</strong>
            <span>Needs retry</span>
          </div>
        </div>
        <div className="chips-row" style={{ marginTop: 10 }}>
          <div className="chip">
            <div
              className={`chip-dot ${
                !connectivityReady
                  ? "dot-checking"
                  : isSyncing
                    ? "dot-syncing"
                    : isOnline
                      ? "dot-online"
                      : "dot-offline"
              }`}
            />
            {!connectivityReady
              ? "Checking…"
              : isSyncing
                ? "Uploading…"
                : isOnline
                  ? "Online"
                  : "Offline — local only"}
          </div>
          <button
            type="button"
            className="btn-outline chip-action"
            onClick={() => void syncNow()}
            disabled={!isOnline || isSyncing || pendingSyncLocal + failedLocal === 0}
          >
            Sync now
          </button>
        </div>
      </section>

      {error ? <div className="form-error">{error}</div> : null}
      {message ? <div className="attendance-banner">{message}</div> : null}
      {failedAttendance?.length ? (
        <section className="card-section" aria-label="Failed attendance uploads">
          <span className="section-title">Attendance needing attention</span>
          <p className="field-overview-copy">
            Failed uploads stay on this device until retry succeeds or you discard them. Retry does not
            create a second mark for the same day.
          </p>
          {failedAttendance.map((row) => (
            <div key={row.id} className="ledger-item ledger-actions-row">
              <div className="ledger-info">
                <div className="ledger-title">{row.title || "Attendance mark"}</div>
                <div className="ledger-meta">
                  {row.attendanceDate} · {syncStatusLabel(row.status)} · {row.lastError || "Upload failed."}
                </div>
              </div>
              <div className="ledger-actions">
                <button type="button" className="btn-outline" onClick={() => void retryAttendance(row.id)}>
                  Retry
                </button>
                <button type="button" className="btn-outline" onClick={() => void discardAttendance(row.id)}>
                  Discard
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {connectivityReady && !isOnline ? (
        <div className="attendance-banner">
          Offline — marks stay on this device and upload under your login while the app is open and online.
        </div>
      ) : null}

      <nav className="attendance-subtabs" aria-label="Attendance views">
        <button
          type="button"
          className={bucket === "active" ? "is-active" : ""}
          onClick={() => setBucket("active")}
        >
          Active
          <span className="attendance-count">{totalActive}</span>
        </button>
        <button
          type="button"
          className={bucket === "history" ? "is-active" : ""}
          onClick={() => setBucket("history")}
        >
          History
          <span className="attendance-count">{totalHistory}</span>
        </button>
      </nav>

      {!hasCampaignSection && !hasSkillSection ? (
        <p className="field-empty-state">
          {isHistory
            ? "No past attendance assignments on this device."
            : "No active attendance assignments. Go online once to refresh your list."}
        </p>
      ) : null}

      {hasCampaignSection ? (
        <section className="field-section">
          <div className="section-heading">
            <h2>{isHistory ? "Past campaigns" : "Campaigns"}</h2>
          </div>
          <div className="attendance-list">
            {campaignItems.map((item) => {
              const marked = markedToday(item.attendance_summary);
              const pendingLocal = Boolean(item.attendance_summary?.pending_sync);
              const days = daysPresent(item.attendance_summary);
              const span = assignmentDaySpan(item);
              const remaining = span != null ? Math.max(0, span - days) : null;
              return (
                <article key={`${item.assignment_id || "x"}-${item.title}`} className="attendance-card">
                  <div>
                    <h3>{item.title}</h3>
                    <p className="subtle">{item.subtitle}</p>
                    {item.location ? <p className="subtle">{item.location}</p> : null}
                  </div>
                  <div className="attendance-meta">
                    <span>Days attended: {days}</span>
                    <span>
                      Counts as: {volunteerCount(item)} {volunteerCount(item) === 1 ? "person" : "people"}
                    </span>
                    {item.lifecycle ? (
                      <span>Status: {String(item.lifecycle).replaceAll("_", " ")}</span>
                    ) : null}
                    {item.start_date || item.end_date ? (
                      <span>
                        {item.start_date || "—"} → {item.end_date || "—"}
                      </span>
                    ) : null}
                    <span>
                      Last marked: {item.attendance_summary?.last_attendance_at || "Not yet"}
                      {pendingLocal ? " · Saved locally (not uploaded yet)" : ""}
                    </span>
                  </div>
                  {span != null ? (
                    <div className="field-progress" aria-label={`Attendance progress ${days} of ${span} days`}>
                      <div className="field-progress-meta">
                        <span>
                          {days} of {span} campaign days
                        </span>
                        <span>{remaining} remaining</span>
                      </div>
                      <div className="field-progress-track" role="presentation">
                        <div
                          className="field-progress-fill"
                          style={{ width: `${Math.min(100, Math.round((days / span) * 100))}%` }}
                        />
                      </div>
                    </div>
                  ) : null}
                  {!isHistory ? (
                    <button
                      type="button"
                      className="btn-attendance-mark"
                      disabled={!item.can_mark || marked}
                      onClick={() => openCapture(item, "selfie")}
                    >
                      {marked
                        ? pendingLocal
                          ? "Today saved locally"
                          : "Today already marked"
                        : !item.can_mark
                          ? item.mark_blocked_reason || "Attendance is not open"
                          : "Mark attendance"}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {hasSkillSection ? (
        <section className="field-section">
          <div className="section-heading">
            <h2>{isHistory ? "Past skills" : "Skills"}</h2>
          </div>
          <div className="attendance-list">
            {skillItems.map((item) => {
              const marked = markedToday(item.attendance_summary);
              const pendingLocal = Boolean(item.attendance_summary?.pending_sync);
              const summary = item.attendance_summary || {};
              return (
                <article key={item.assignment_id} className="attendance-card">
                  <div>
                    <h3>{item.title}</h3>
                    <p className="subtle">
                      {item.subtitle}
                      {item.assignee_email ? ` · ${item.assignee_email}` : ""}
                    </p>
                  </div>
                  <div className="attendance-meta">
                    <span>
                      Daily rate:{" "}
                      {item.daily_rate > 0
                        ? `INR ${Number(item.daily_rate).toLocaleString("en-IN")}`
                        : "Not set"}
                    </span>
                    <span>Days present: {daysPresent(summary)}</span>
                    <span>
                      Unpaid: INR{" "}
                      {Math.max(
                        0,
                        Number(summary.total_due || 0) - Number(summary.paid_total || 0)
                      ).toLocaleString("en-IN")}
                    </span>
                    <span>
                      Last marked: {summary.last_attendance_at || "Not yet"}
                      {pendingLocal ? " · Saved locally (not uploaded yet)" : ""}
                    </span>
                  </div>
                  {!isHistory ? (
                    <button
                      type="button"
                      className="btn-attendance-mark"
                      disabled={!item.can_mark || marked}
                      onClick={() => openCapture(item, "photo")}
                    >
                      {marked
                        ? pendingLocal
                          ? "Today saved locally"
                          : "Today already marked"
                        : !item.can_mark
                          ? item.mark_blocked_reason || "Attendance is not open"
                          : "Mark attendance"}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {captureTarget ? (
        <AttendanceCaptureSheet
          item={captureTarget.item}
          mode={captureTarget.mode}
          userId={session!.id}
          isOnline={isOnline}
          syncNow={syncNow}
          onClose={() => setCaptureTarget(null)}
          onMarked={async (msg) => {
            setCaptureTarget(null);
            setMessage(msg);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

const ATTENDANCE_MAX_PHOTOS = 3;

type SealedAttendancePhoto = {
  blob: Blob;
  url: string;
  name: string;
  proofHash: string;
  capturedAt: string;
};

function AttendanceCaptureSheet(props: {
  item: any;
  mode: "selfie" | "photo";
  userId: string;
  isOnline: boolean;
  syncNow: () => Promise<void>;
  onClose: () => void;
  onMarked: (message: string) => void | Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [photos, setPhotos] = useState<SealedAttendancePhoto[]>([]);
  const [coords, setCoords] = useState<{
    latitude: number;
    longitude: number;
    accuracy: number | null;
  } | null>(null);
  const [locating, setLocating] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photosRef = useRef<SealedAttendancePhoto[]>([]);

  const isSelfie = props.mode === "selfie";
  const todayLabel = getLocalDateStringClient();

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraReady(false);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraLoading(true);
    setError(null);
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: isSelfie ? "user" : "environment" },
        audio: false,
      });
      if (!videoRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      videoRef.current.srcObject = stream;
      streamRef.current = stream;
      setCameraReady(true);
    } catch (err) {
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      setError(
        denied
          ? "Camera access was blocked. Allow camera access in your browser settings, then try again."
          : "The camera could not be opened. Close other apps using it and try again."
      );
    } finally {
      setCameraLoading(false);
    }
  }, [isSelfie, stopCamera]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLocating(true);
      const position = await getCurrentPosition();
      if (cancelled) return;
      if (!position) {
        setError("Location is required. Enable GPS and try again.");
        setLocating(false);
        return;
      }
      setCoords(position);
      setLocating(false);
      await startCamera();
    })();
    return () => {
      cancelled = true;
      stopCamera();
      photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.url));
    };
  }, [startCamera, stopCamera]);

  async function captureSealedPhoto() {
    if (!videoRef.current || !canvasRef.current || !cameraReady || !coords) return;
    if (photos.length >= ATTENDANCE_MAX_PHOTOS) {
      setError(`Maximum ${ATTENDANCE_MAX_PHOTOS} photos for today.`);
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) return;

    const video = videoRef.current;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;

    context.save();
    if (isSelfie) {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    context.restore();

    const capturedAt = new Date().toISOString();
    const stampTime = new Date().toLocaleString();
    const lat = coords.latitude.toFixed(6);
    const lng = coords.longitude.toFixed(6);

    context.fillStyle = "rgba(0,0,0,0.45)";
    context.fillRect(0, canvas.height - 110, canvas.width, 110);
    context.font = "bold 22px monospace";
    context.fillStyle = "#fde047";
    context.fillText(stampTime, 16, canvas.height - 72);
    context.fillText(`DATE ${todayLabel}`, 16, canvas.height - 44);
    context.fillText(`GPS ${lat}, ${lng}`, 16, canvas.height - 16);
    context.font = "16px monospace";
    context.fillText((props.item.title || "Attendance").slice(0, 42), 16, canvas.height - 96);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92)
    );
    if (!blob) {
      setError("Could not seal photo.");
      return;
    }

    const proofHash = await calculateHash(blob);
    const url = URL.createObjectURL(blob);
    setPhotos((prev) => {
      const next = [
        ...prev,
        {
          blob,
          url,
          name: `attendance-${todayLabel}-${prev.length + 1}.jpg`,
          proofHash,
          capturedAt,
        },
      ];
      photosRef.current = next;
      return next;
    });
    setError(null);
  }

  async function submitAttendance() {
    if (!coords) {
      setError("Location is required.");
      return;
    }
    if (photos.length < 1) {
      setError(isSelfie ? "Take at least one selfie." : "Take at least one photo.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await enqueueAttendanceMark({
        userId: props.userId,
        assignmentId: String(props.item.assignment_id),
        mode: props.mode,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        units: props.mode === "photo" ? 1 : null,
        title: String(props.item.title || "Attendance"),
        photos: photos.map((photo) => ({
          blob: photo.blob,
          name: photo.name,
          proofHash: photo.proofHash,
          capturedAt: photo.capturedAt,
        })),
      });

      const capacity = Math.max(1, Number(props.item.volunteer_capacity) || 1);
      const count = photos.length;
      stopCamera();

      if (props.isOnline) {
        await props.syncNow();
      }

      const offlineNote = props.isOnline
        ? " Saved on this device; upload runs while the app stays open and online."
        : " Saved on this device — will upload under your login when the app is open and online.";

      await props.onMarked(
        isSelfie
          ? capacity > 1
            ? `Present sealed with ${count} selfie(s) (counts as ${capacity} people).${offlineNote}`
            : `Present sealed with ${count} selfie(s).${offlineNote}`
          : `Marked ${props.item.subtitle || "the assignee"} present with ${count} sealed photo(s).${offlineNote}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark attendance");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="attendance-capture-sheet" role="dialog" aria-modal="true">
      <div className="attendance-capture-card">
        <header className="attendance-capture-header">
          <div>
            <h3>{isSelfie ? "Self attendance selfie" : "Skill attendance photo"}</h3>
            <p className="subtle">{props.item.title}</p>
          </div>
          <button type="button" className="btn-outline" onClick={props.onClose} disabled={submitting}>
            Cancel
          </button>
        </header>

        {locating || cameraLoading ? (
          <div className="skeleton-inline-row" aria-busy="true">
            <Skeleton className="skeleton-line-sm" />
            <span className="sr-only">{locating ? "Acquiring GPS" : "Opening camera"}</span>
          </div>
        ) : null}
        {coords ? (
          <p className="attendance-capture-gps">
            GPS · {coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)} · {todayLabel}
          </p>
        ) : null}

        <div className="viewfinder attendance-viewfinder">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={isSelfie ? { transform: "scaleX(-1)" } : undefined}
          />
          {!cameraReady && (
            <div className="viewfinder-skeleton attendance-viewfinder-empty" aria-busy={cameraLoading}>
              {cameraLoading ? <Skeleton className="skeleton-viewfinder" /> : null}
              <span className="sr-only">
                {cameraLoading ? "Opening camera" : "Camera offline"}
              </span>
            </div>
          )}
          <canvas ref={canvasRef} hidden />
        </div>

        <div className="attendance-capture-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void captureSealedPhoto()}
            disabled={
              submitting || !cameraReady || !coords || photos.length >= ATTENDANCE_MAX_PHOTOS
            }
          >
            Capture
          </button>
          <div className="capture-count" aria-live="polite">
            {photos.length}<span>/{ATTENDANCE_MAX_PHOTOS}</span>
          </div>
        </div>

        {photos.length > 0 ? (
          <div className="attendance-sealed-thumbs">
            {photos.map((photo, index) => (
              <div key={photo.proofHash} className="attendance-sealed-thumb">
                <img src={photo.url} alt={`Sealed ${index + 1}`} />
                <span>Locked #{index + 1}</span>
              </div>
            ))}
          </div>
        ) : null}

        {error ? <div className="form-error">{error}</div> : null}

        <button
          type="button"
          className="btn-primary"
          style={{ width: "100%", marginTop: 12 }}
          disabled={submitting || photos.length < 1 || !coords}
          onClick={() => void submitAttendance()}
        >
          {submitting ? "Sealing attendance…" : "Submit sealed attendance"}
        </button>
      </div>
    </div>
  );
}

function NgoCaptureView(props: any) {
  const { isSyncing } = useAppContext();
  const [officerName, setOfficerName] = useState("");
  const [notes, setNotes] = useState("");

  const milestones = useLiveQuery(() => db.milestones.orderBy("milestoneOrder").toArray(), [], []);

  const projectMilestones = useMemo(() => {
    if (!milestones?.length) return [] as LocalMilestone[];
    const byProject = new Map<string, LocalMilestone[]>();
    for (const row of milestones) {
      const list = byProject.get(row.projectId) || [];
      list.push(row);
      byProject.set(row.projectId, list);
    }
    // Prefer a project that still has unpaid field progress.
    for (const list of byProject.values()) {
      const ordered = sortMilestonesByOrder(list);
      const current = resolveCurrentFieldMilestone(ordered);
      if (current && !isPaidCompletedMilestoneStatus(current.status)) return ordered;
    }
    const first = byProject.values().next().value as LocalMilestone[] | undefined;
    return first ? sortMilestonesByOrder(first) : [];
  }, [milestones]);

  const activeMilestone = useMemo(
    () => resolveCurrentFieldMilestone(projectMilestones),
    [projectMilestones]
  );

  const milestoneProgress = useMemo(() => {
    if (!activeMilestone || projectMilestones.length === 0) {
      return { past: null as LocalMilestone | null, current: null as LocalMilestone | null, next: null as LocalMilestone | null, index: 0, total: 0 };
    }
    const index = Math.max(
      0,
      projectMilestones.findIndex((m) => m.id === activeMilestone.id)
    );
    return {
      past: index > 0 ? projectMilestones[index - 1] : null,
      current: projectMilestones[index] || activeMilestone,
      next: index < projectMilestones.length - 1 ? projectMilestones[index + 1] : null,
      index,
      total: projectMilestones.length,
    };
  }, [activeMilestone, projectMilestones]);

  if (milestones === undefined || (isSyncing && milestones.length === 0)) {
    return <CardSectionSkeleton rows={4} />;
  }

  if (!activeMilestone) {
    return (
      <section className="card-section">
        <span className="section-title">Milestone info</span>
        <p className="field-empty-state">
          No open milestones on this device. Connect online and tap Sync so project assignments can refresh.
        </p>
      </section>
    );
  }

  const isLocked = isLockedMilestoneStatus(activeMilestone.status);
  const awaitingPayment = String(activeMilestone.status || "").toLowerCase() === "approved";

  return (
    <>
      <section className="card-section">
        <div className="milestone-progress">
          <div className="milestone-progress-head">
            <span className="section-title" style={{ marginBottom: 0 }}>
              Milestone info
            </span>
            <span className="milestone-progress-count">
              {milestoneProgress.index + 1}/{milestoneProgress.total}
            </span>
          </div>

          <ol className="milestone-progress-track" aria-label="Milestone progress">
            <li className={`milestone-progress-step${milestoneProgress.past ? " is-past" : " is-empty"}`}>
              <span className="milestone-progress-label">Past</span>
              <strong>{milestoneProgress.past?.title || "—"}</strong>
              <span className="milestone-progress-meta">
                {milestoneProgress.past ? fieldMilestoneStepLabel(milestoneProgress.past.status) : "None"}
              </span>
            </li>
            <li className="milestone-progress-step is-current">
              <span className="milestone-progress-label">Current</span>
              <strong>{milestoneProgress.current?.title || activeMilestone.title}</strong>
              <span className="milestone-progress-meta">{fieldMilestoneStepLabel(activeMilestone.status)}</span>
            </li>
            <li className={`milestone-progress-step${milestoneProgress.next ? " is-next" : " is-empty"}`}>
              <span className="milestone-progress-label">Next</span>
              <strong>{milestoneProgress.next?.title || "—"}</strong>
              <span className="milestone-progress-meta">
                {milestoneProgress.next
                  ? awaitingPayment
                    ? "Locked until payment"
                    : fieldMilestoneStepLabel(milestoneProgress.next.status)
                  : "End"}
              </span>
            </li>
          </ol>
          {awaitingPayment ? (
            <p style={{ marginTop: 10, marginBottom: 0, fontSize: "0.8rem", color: "var(--text-muted)" }}>
              Evidence for this milestone is approved. The next milestone unlocks after payment is confirmed.
            </p>
          ) : null}
        </div>
      </section>

      <CameraCard {...props} contextLabel={activeMilestone.title} disabled={isLocked} />

      <section className="card-section">
        <span className="section-title">Details</span>
        <p className="field-overview-copy">
          Seal at least one photo with GPS, then submit. The record stays local until the server confirms
          upload. Milestone review happens later on the platform.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            props.onSeal({
              beneficiaryName: officerName.trim(),
              interactionType: "visit",
              notes,
              projectId: activeMilestone.projectId,
              projectName: activeMilestone.title,
              milestoneId: activeMilestone.id,
              referencePointId: null,
            });
          }}
        >
          <fieldset disabled={isLocked || props.submitting} style={{ border: "none", padding: 0, margin: 0 }}>
            <div className="form-group">
              <label htmlFor="officer-name">Officer name</label>
              <input
                id="officer-name"
                value={officerName}
                onChange={(e) => setOfficerName(e.target.value)}
                required
                autoComplete="name"
                placeholder="Field officer full name"
              />
            </div>
            <div className="form-group">
              <label htmlFor="evidence-notes">Notes</label>
              <textarea
                id="evidence-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                required
                rows={3}
                placeholder="What was observed on this field visit"
              />
            </div>
          </fieldset>
          {props.submitState ? (
            <div
              className={props.submitState.tone === "error" ? "form-error" : "form-success"}
              style={{ marginBottom: 14 }}
            >
              {props.submitState.message}
            </div>
          ) : null}
          {!isLocked && (
            <button
              type="submit"
              className="btn-primary"
              disabled={props.submitting || props.capturedBlobs.length === 0}
            >
              Submit evidence
            </button>
          )}
        </form>
      </section>
    </>
  );
}

function CameraCard(props: any) {
  const todayLabel = getLocalDateStringClient();
  const coords = props.evidenceCoords;
  return (
    <section className="card-section">
      <span className="section-title">Capture</span>
      {props.evidenceLocating || props.cameraLoading ? (
        <div className="skeleton-inline-row" aria-busy="true" style={{ marginBottom: 8 }}>
          <Skeleton className="skeleton-line-sm" />
          <span className="sr-only">{props.evidenceLocating ? "Acquiring GPS" : "Opening camera"}</span>
        </div>
      ) : null}
      {coords ? (
        <p className="attendance-capture-gps" style={{ marginBottom: 8 }}>
          GPS · {coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)} · {todayLabel}
        </p>
      ) : null}

      <div className="viewfinder">
          <video ref={props.videoRef} autoPlay playsInline muted />
          {!props.cameraReady && (
            <div className="viewfinder-skeleton" aria-busy={props.cameraLoading}>
              {props.cameraLoading ? <Skeleton className="skeleton-viewfinder" /> : null}
              <span className="sr-only">
                {props.cameraLoading ? "Opening camera" : "Camera offline"}
              </span>
            </div>
          )}
          <div className="viewfinder-overlay">
            <div className="viewfinder-corner top-l" />
            <div className="viewfinder-corner top-r" />
            <div className="viewfinder-corner bot-l" />
            <div className="viewfinder-corner bot-r" />
          </div>
          <canvas ref={props.canvasRef} hidden />
        </div>

      {props.cameraError ? <div className="form-error" style={{ marginBottom: '12px' }}>{props.cameraError}</div> : null}

      <div className="capture-shutter-row">
         <button
           type="button"
           className="btn-shutter"
           aria-label="Capture photo"
           onClick={() => props.capturePhoto(props.contextLabel)}
           disabled={props.disabled || !props.cameraReady || !coords || props.capturedBlobs.length >= 5}
         >
           <div className="btn-shutter-inner" />
         </button>
         <div className="capture-count" aria-live="polite">
           {props.capturedBlobs.length}<span>/5</span>
         </div>
      </div>
      <div className="chips-row" style={{ marginTop: '20px' }}>
        {props.capturedBlobs.map((item: any, idx: number) => (
          <div key={item.url} style={{ position: 'relative' }}>
            <img 
              src={item.url} 
              style={{ width: '50px', height: '50px', borderRadius: '10px', objectFit: 'cover', cursor: 'pointer' }} 
              alt="cap" 
              onClick={() => props.onPreviewImage(item.url)}
            />
            <button type="button" aria-label="Remove photo" onClick={() => props.onRemovePhoto(idx)} style={{ position: 'absolute', top: -5, right: -5, background: 'var(--error)', color: '#fff', borderRadius: '50%', width: '18px', height: '18px', fontSize: '10px', border: '2px solid #fff' }}>×</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function LedgerItemMedia({ media, onPreview }: { media: LocalMediaRecord[], onPreview: (url: string) => void }) {
  const urls = useMemo(() => {
    return media.map(m => URL.createObjectURL(m.blob));
  }, [media]);

  useEffect(() => {
    return () => {
      urls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [urls]);

  if (media.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
      {media.map((item, idx) => (
        <img
          key={item.id}
          src={urls[idx]}
          className="ledger-thumb"
          style={{ cursor: 'pointer', border: '1.5px solid var(--line)' }}
          alt={item.fileName}
          onClick={() => onPreview(urls[idx])}
        />
      ))}
    </div>
  );
}
