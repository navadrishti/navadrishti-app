"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useAppContext } from "@/components/app-provider";
import { AppFooter, ProductBrand } from "@/components/product-brand";
import { CardSectionSkeleton, Skeleton } from "@/components/skeleton";
import { calculateHash } from "@/lib/crypto";
import { db } from "@/lib/db";
import { apiFetch } from "@/lib/env";
import {
  applyPendingAttendanceOverlay,
  enqueueAttendanceMark,
  readAttendanceCache,
  saveAttendanceCache,
} from "@/lib/sync-engine";
import { getDeviceId, getCurrentPosition, getLocalDateStringClient } from "@/lib/utils";
import { randomUUID } from "@/lib/crypto";
import type { LocalMediaRecord, LocalRecord } from "@/lib/types";

if (typeof window !== "undefined") {
  // Dev-only: expose db in console via window.__navadrishti_db if needed
  if (process.env.NODE_ENV === "development") {
    (window as unknown as { __navadrishti_db?: typeof db }).__navadrishti_db = db;
  }
}

export function FieldConsole() {
  const { session, sessionLoading, isOnline, isSyncing, signOut, syncNow } = useAppContext();
  const [activeTab, setActiveTab] = useState<"evidence" | "attendance">("evidence");
  const [capturedBlobs, setCapturedBlobs] = useState<{ blob: Blob; url: string; name: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitState, setSubmitState] = useState<string | null>(null);
  const [deviceId] = useState(() => getDeviceId());
  const [activePreviewUrl, setActivePreviewUrl] = useState<string | null>(null);

  const canEvidence = session?.role === "ngo";
  const canAttendance = session?.role === "ngo" || session?.role === "individual";

  useEffect(() => {
    if (session?.role === "individual") setActiveTab("attendance");
  }, [session?.role]);

  // Camera State
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
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
    if (!session?.id) return { pending: 0, synced: 0, mediaCount: 0 };
    const all = await db.recordsLocal.where("userId").equals(session.id).toArray();
    const mediaCount = await db.mediaLocal.count(); // Count of all local media
    return {
      pending: all.filter(r => r.status === "pending" || r.status === "syncing").length,
      synced: all.filter(r => r.status === "synced").length,
      mediaCount
    };
  }, [session?.id], { pending: 0, synced: 0, mediaCount: 0 });

  // Camera Controls
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraReady(false);
  }, []);

  const startCamera = async () => {
    setCameraLoading(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
        setCameraReady(true);
      }
    } catch (err) {
      console.error("Camera error:", err);
    } finally {
      setCameraLoading(false);
    }
  };

  const capturePhoto = async (contextLabel: string) => {
    if (!videoRef.current || !canvasRef.current || !cameraReady) return;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    context.drawImage(videoRef.current, 0, 0);
    context.font = "24px monospace"; context.fillStyle = "yellow";
    context.fillText(new Date().toLocaleString(), 20, canvas.height - 40);
    context.fillText(contextLabel.slice(0, 30), 20, canvas.height - 70);
    canvas.toBlob(blob => {
      if (blob) setCapturedBlobs(p => [...p, { blob, url: URL.createObjectURL(blob), name: `cap-${Date.now()}.jpg` }]);
    }, "image/jpeg", 0.9);
  };

  useEffect(() => { return () => stopCamera(); }, [stopCamera]);

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
      const coords = await getCurrentPosition();
      if (!coords) throw new Error("Could not acquire GPS signal. Check permissions.");

      const recordId = randomUUID();
      const createdAt = new Date().toISOString();

      const mediaEntries: LocalMediaRecord[] = await Promise.all(
        capturedBlobs.map(async (item) => ({
          id: randomUUID(),
          recordId,
          fileName: item.name,
          mimeType: item.blob.type,
          size: item.blob.size,
          kind: "image" as const,
          blob: item.blob,
          proofHash: await calculateHash(item.blob),
          createdAt,
        }))
      );

      const record: LocalRecord = {
        id: recordId,
        deviceId,
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

      setCapturedBlobs([]);
      setSubmitState("Evidence saved. Will sync when online.");
      if (isOnline) await syncNow();
    } catch (error) {
      setSubmitState(error instanceof Error ? error.message : "Submission failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sessionLoading) return null;

  const statsLoading = stats === undefined;
  const recordsLoading = records === undefined;
  const showHubTabs = canEvidence && canAttendance;
  const showAttendance = canAttendance && (activeTab === "attendance" || !canEvidence);

  return (
    <main className="app field-hub">
      <header className="app-header field-hub-header">
        <div className="header-left field-hub-brand">
          <ProductBrand size="sm" className="header-brand" />
          <div>
            <h1 className="header-org field-hub-user">{session?.ngoName || session?.name || "User"}</h1>
            <p className="header-meta">
              {isOnline ? (isSyncing ? "Syncing…" : "Online") : "Offline"}
            </p>
          </div>
        </div>
        <div className="field-hub-actions">
          {!showAttendance ? (
            <button type="button" className="btn-outline" onClick={() => void syncNow()} disabled={!isOnline || isSyncing}>
              Sync
            </button>
          ) : null}
          <button type="button" className="btn-outline" onClick={signOut}>Sign Out</button>
        </div>
      </header>

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

      {showAttendance ? (
        <AttendancePanel showSkillSection={session?.role === "ngo"} />
      ) : (
        <>
          <section className="card-section">
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
                    <div className={`chip-dot ${isSyncing ? "dot-syncing" : isOnline ? "dot-online" : "dot-offline"}`} />
                    {isSyncing ? "Syncing…" : isOnline ? "Server Live" : "Local Only"}
                  </div>
                  <div className="chip">
                    <span className="badge badge-slate">Queue</span> {stats.pending}
                  </div>
                  <div className="chip">
                    <span className="badge badge-blue">Media</span> {stats.mediaCount}
                  </div>
                </>
              )}
            </div>
          </section>

          <NgoCaptureView
            onSeal={handleSeal}
            submitting={submitting}
            submitState={submitState}
            capturedBlobs={capturedBlobs}
            setCapturedBlobs={setCapturedBlobs}
            cameraReady={cameraReady}
            cameraLoading={cameraLoading}
            startCamera={startCamera}
            stopCamera={stopCamera}
            capturePhoto={capturePhoto}
            videoRef={videoRef}
            canvasRef={canvasRef}
            onPreviewImage={setActivePreviewUrl}
          />

          <section className="card-section">
            <span className="section-title">Recent Device History</span>
            <div style={{ display: "grid", gap: "8px" }}>
              {recordsLoading ? (
                <>
                  <Skeleton className="skeleton-ledger" />
                  <Skeleton className="skeleton-ledger" />
                  <Skeleton className="skeleton-ledger" />
                </>
              ) : records.length === 0 ? (
                <p style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
                  No local records found.
                </p>
              ) : (
                records.slice(0, 5).map((r) => (
                  <div key={r.id} className="ledger-item" style={{ flexDirection: "column", alignItems: "stretch" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                      <div className="ledger-info">
                        <div className="ledger-title">{r.beneficiaryName || "Evidence Record"}</div>
                        <div className="ledger-meta">{r.projectName} • {new Date(r.submittedAtDevice).toLocaleTimeString()}</div>
                      </div>
                      <div className={`status-badge status-${r.status}`}>{r.status}</div>
                    </div>
                    <LedgerItemMedia media={r.media} onPreview={setActivePreviewUrl} />
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}

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
  const { session, isOnline, syncNow } = useAppContext();
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
  const skillItems = bucket === "active" ? activeSkills : historySkills;
  const isHistory = bucket === "history";

  const markedToday = (summary: any) =>
    String(summary?.last_attendance_at || "") === getLocalDateStringClient();
  const daysPresent = (summary: any) =>
    Number(summary?.days_attended ?? summary?.total_entries ?? 0);

  function openCapture(item: any, mode: "selfie" | "photo") {
    if (!item.assignment_id || !item.can_mark) return;
    if (markedToday(item.attendance_summary)) {
      setMessage(
        item.attendance_summary?.pending_sync
          ? "Today's attendance is saved on this device and will sync when online."
          : "Today's attendance is already marked and cannot be changed."
      );
      return;
    }
    setMessage(null);
    setCaptureTarget({ item, mode });
  }

  if (loading) {
    return (
      <section className="field-section" style={{ margin: 16 }}>
        <p className="subtle">Loading attendance…</p>
      </section>
    );
  }

  return (
    <div className="attendance-console">
      {error ? <div className="form-error">{error}</div> : null}
      {message ? <div className="attendance-banner">{message}</div> : null}
      {!isOnline ? (
        <div className="attendance-banner">
          Offline mode — marks are saved on this device and sync under your login when internet returns.
        </div>
      ) : null}

      <nav className="attendance-subtabs" aria-label="Attendance views">
        <button
          type="button"
          className={bucket === "active" ? "is-active" : ""}
          onClick={() => setBucket("active")}
        >
          Active
          <span className="attendance-count">
            {activeCampaigns.length + (showSkillSection ? activeSkills.length : 0)}
          </span>
        </button>
        <button
          type="button"
          className={bucket === "history" ? "is-active" : ""}
          onClick={() => setBucket("history")}
        >
          History
          <span className="attendance-count">
            {historyCampaigns.length + (showSkillSection ? historySkills.length : 0)}
          </span>
        </button>
      </nav>

      <section className="field-section">
        <div className="section-heading">
          <h2>{isHistory ? "Past CSR campaigns" : "Active CSR campaigns"}</h2>
          <p className="subtle">
            {isHistory
              ? "Campaigns you participated in that have ended or were cancelled."
              : "Mark yourself present once per day with a sealed selfie (up to 3 photos). Location, date and time are stamped; today's mark cannot be edited."}
          </p>
        </div>
        {campaignItems.length === 0 ? (
          <p className="subtle">
            {isHistory ? "No past campaign projects yet." : "No active campaign projects yet."}
          </p>
        ) : (
          <div className="attendance-list">
            {campaignItems.map((item) => {
              const marked = markedToday(item.attendance_summary);
              return (
                <article key={`${item.assignment_id || "x"}-${item.title}`} className="attendance-card">
                  <div>
                    <h3>{item.title}</h3>
                    <p className="subtle">{item.subtitle}</p>
                    {item.location ? <p className="subtle">{item.location}</p> : null}
                  </div>
                  <div className="attendance-meta">
                    <span>Days attended: {daysPresent(item.attendance_summary)}</span>
                    <span>
                      Counts as: {item.volunteer_capacity}{" "}
                      {item.volunteer_capacity === 1 ? "person" : "people"}
                    </span>
                    <span>Status: {String(item.lifecycle || "").replaceAll("_", " ")}</span>
                    {item.start_date || item.end_date ? (
                      <span>
                        {item.start_date || "—"} → {item.end_date || "—"}
                      </span>
                    ) : null}
                    <span>Last marked: {item.attendance_summary?.last_attendance_at || "Not yet"}</span>
                  </div>
                  {!isHistory ? (
                    <button
                      type="button"
                      disabled={!item.can_mark || marked}
                      onClick={() => openCapture(item, "selfie")}
                    >
                      {marked
                        ? "Today already marked"
                        : item.lifecycle === "yet_to_start"
                          ? "Opens when campaign starts"
                          : "Take selfie & mark"}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {showSkillSection ? (
        <section className="field-section">
          <div className="section-heading">
            <h2>{isHistory ? "Past skill / service needs" : "Skill / service needs"}</h2>
            <p className="subtle">
              {isHistory
                ? "Completed or cancelled skill/service assignments."
                : "Mark the assignee present once per day with sealed photos (up to 3). Stamped with date, time and location; today's mark cannot be edited."}
            </p>
          </div>
          {skillItems.length === 0 ? (
            <p className="subtle">
              {isHistory
                ? "No past skill/service assignments."
                : "No skill/service assignments to mark right now."}
            </p>
          ) : (
            <div className="attendance-list">
              {skillItems.map((item) => {
                const marked = markedToday(item.attendance_summary);
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
                      <span>Due: INR {Number(summary.total_due || 0).toLocaleString("en-IN")}</span>
                      <span>Last marked: {summary.last_attendance_at || "Not yet"}</span>
                    </div>
                    {!isHistory ? (
                      <button
                        type="button"
                        disabled={!item.can_mark || marked}
                        onClick={() => openCapture(item, "photo")}
                      >
                        {marked ? "Today already marked" : "Capture photo & mark"}
                      </button>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
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
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
        setCameraReady(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open camera");
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

      const capacity = Number(props.item.volunteer_capacity || 1);
      const count = photos.length;
      stopCamera();

      if (props.isOnline) {
        await props.syncNow();
      }

      const offlineNote = props.isOnline
        ? ""
        : " Saved on this device — will upload under your login when internet returns.";

      await props.onMarked(
        isSelfie
          ? capacity > 1
            ? `Present sealed with ${count} selfie(s) (counts as ${capacity} people).${offlineNote}`
            : `Present sealed with ${count} selfie(s).${offlineNote}`
          : `Marked ${props.item.subtitle} present with ${count} sealed photo(s).${offlineNote}`
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

        <p className="subtle attendance-capture-hint">
          Up to {ATTENDANCE_MAX_PHOTOS} photos. Once taken, photos are locked (not removable). Each
          frame is stamped with date, time and GPS. Today&apos;s attendance cannot be edited after
          submit.
        </p>

        {locating ? <p className="subtle">Acquiring GPS…</p> : null}
        {coords ? (
          <p className="attendance-capture-gps">
            GPS locked · {coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)} · {todayLabel}
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
            <div className="attendance-viewfinder-empty">
              {cameraLoading ? "Opening camera…" : "Camera offline"}
            </div>
          )}
          <canvas ref={canvasRef} hidden />
        </div>

        <div className="attendance-capture-actions">
          <button
            type="button"
            className="btn-outline"
            onClick={() => void startCamera()}
            disabled={submitting || locating || !coords}
          >
            {cameraReady ? "Restart camera" : "Open camera"}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void captureSealedPhoto()}
            disabled={
              submitting || !cameraReady || !coords || photos.length >= ATTENDANCE_MAX_PHOTOS
            }
          >
            {isSelfie ? "Capture selfie" : "Capture photo"} ({photos.length}/{ATTENDANCE_MAX_PHOTOS})
          </button>
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
  const [beneficiaryName, setBeneficiaryName] = useState("");
  const [notes, setNotes] = useState("");
  const [interactionType, setInteractionType] = useState("visit");

  const milestones = useLiveQuery(() => db.milestones.orderBy("milestoneOrder").toArray(), [], []);
  const activeMilestone = useMemo(() => {
    if (!milestones || milestones.length === 0) return null;
    return milestones.find((m) => m.status !== "paid") || milestones[0];
  }, [milestones]);

  if (milestones === undefined || (isSyncing && milestones.length === 0)) {
    return <CardSectionSkeleton rows={4} />;
  }

  if (!activeMilestone) {
    return (
      <section className="card-section">
        <span className="section-title">CSR Milestone</span>
        <p style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
          No CSR assignments found.
        </p>
      </section>
    );
  }

  const isLocked = activeMilestone.status !== "pending";

  return (
    <>
      <section className="card-section">
        <span className="section-title">CSR Milestone</span>
        <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>{activeMilestone.title}</div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{activeMilestone.description}</p>
      </section>

      <CameraCard {...props} contextLabel={activeMilestone.title} />

      <section className="card-section">
        <span className="section-title">Record Details</span>
        <form onSubmit={e => { e.preventDefault(); props.onSeal({ beneficiaryName, interactionType, notes, projectId: activeMilestone.projectId, projectName: activeMilestone.title, milestoneId: activeMilestone.id, referencePointId: null }); }}>
          <fieldset disabled={isLocked || props.submitting} style={{ border: 'none' }}>
            <div className="form-group">
              <label>Beneficiary Name</label>
              <input value={beneficiaryName} onChange={e => setBeneficiaryName(e.target.value)} required placeholder="Full legal name" />
            </div>
            <div className="form-group">
              <label>Interaction</label>
              <select value={interactionType} onChange={e => setInteractionType(e.target.value)}>
                <option value="visit">Field Visit</option>
                <option value="distribution">Distribution</option>
              </select>
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} required rows={3} />
            </div>
          </fieldset>
          {props.submitState && <div className="form-success">{props.submitState}</div>}
          {!isLocked && <button type="submit" className="btn-primary" disabled={props.submitting || props.capturedBlobs.length === 0}>Submit Evidence</button>}
        </form>
      </section>
    </>
  );
}

function CameraCard(props: any) {
  return (
    <section className="card-section">
      <span className="section-title">Evidence Capture</span>

      <div className="viewfinder">
          <video ref={props.videoRef} autoPlay playsInline muted />
          {!props.cameraReady && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: '#000', color: '#fff', fontSize: '0.75rem' }}>{props.cameraLoading ? "Hardware Initialising..." : "Viewfinder Offline"}</div>}
          <div className="viewfinder-overlay">
            <div className="viewfinder-corner top-l" />
            <div className="viewfinder-corner top-r" />
            <div className="viewfinder-corner bot-l" />
            <div className="viewfinder-corner bot-r" />
          </div>
          <canvas ref={props.canvasRef} hidden />
        </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
         <button className="btn-outline" onClick={props.cameraReady ? props.stopCamera : props.startCamera} style={{ flex: 1 }}>{props.cameraReady ? "Stop Feed" : "Open Camera"}</button>
         <button className="btn-shutter" onClick={() => props.capturePhoto(props.contextLabel)} disabled={!props.cameraReady || props.capturedBlobs.length >= 5}><div className="btn-shutter-inner" /></button>
         <div style={{ flex: 1, textAlign: 'right', fontWeight: 800, fontSize: '1.5rem' }}>{props.capturedBlobs.length}<span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>/5</span></div>
      </div>
      <div className="chips-row" style={{ marginTop: '20px' }}>
        {props.capturedBlobs.map((item: any, idx: number) => (
          <div key={idx} style={{ position: 'relative' }}>
            <img 
              src={item.url} 
              style={{ width: '50px', height: '50px', borderRadius: '10px', objectFit: 'cover', cursor: 'pointer' }} 
              alt="cap" 
              onClick={() => props.onPreviewImage(item.url)}
            />
            <button onClick={() => props.setCapturedBlobs((p: any) => p.filter((_: any, i: any) => i !== idx))} style={{ position: 'absolute', top: -5, right: -5, background: 'var(--error)', color: '#fff', borderRadius: '50%', width: '18px', height: '18px', fontSize: '10px', border: '2px solid #fff' }}>×</button>
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
