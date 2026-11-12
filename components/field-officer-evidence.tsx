"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/env";
import { getDeviceId } from "@/lib/utils";
import { db } from "@/lib/db";
import { randomUUID, calculateHash } from "@/lib/crypto";
import { processSyncQueue } from "@/lib/sync-engine";
import {
  fieldMilestoneStepLabel,
  isLockedMilestoneStatus,
  priorMilestonesArePaidComplete,
  resolveCurrentFieldMilestone,
  validateEvidenceFiles,
} from "@/lib/evidence-rules";
import type { AppSession, LocalMediaRecord, LocalRecord } from "@/lib/types";

type FoMilestone = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  milestone_order: number;
  status: string;
  amount: number;
  due_date: string | null;
  evidence_requirements: unknown;
  updated_at: string | null;
  latest_evidence?: {
    id: string;
    submission_status: string;
    description: string | null;
    captured_at: string;
    uploaded_at: string | null;
    gps_lat: number | null;
    gps_long: number | null;
  } | null;
  latest_review?: {
    decision: string;
    comments: string | null;
    reviewed_at: string | null;
  } | null;
};

type FoProject = {
  id: string;
  title: string;
  description: string | null;
  region: string | null;
  project_status: string;
  csr_project_milestones: FoMilestone[];
};

type CapturedBlob = {
  name: string;
  blob: Blob;
  url: string;
  proofHash: string;
  kind: "image" | "video";
};

type QueueSummary = {
  pending: number;
  syncing: number;
  failed: number;
  syncedRecently: number;
};

function requirementsList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && "label" in item) {
        return String((item as { label?: unknown }).label || "").trim();
      }
      return String(item || "").trim();
    })
    .filter(Boolean);
}

function reviewLabel(milestone: FoMilestone): string {
  const decision = String(milestone.latest_review?.decision || "").toLowerCase();
  if (decision === "approved") return "Approved";
  if (decision === "rejected") return "Rejected — resubmit";
  const status = String(milestone.status || "").toLowerCase();
  if (status === "submitted") return "Awaiting review";
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected — resubmit";
  if (status === "completed") return "Completed";
  if (milestone.latest_evidence) return "Submitted";
  return "No evidence yet";
}

async function getCurrentPosition(): Promise<{ latitude: number; longitude: number; accuracy: number | null } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

export function FieldOfficerEvidence({
  session,
}: {
  session: AppSession;
}) {
  const [projects, setProjects] = useState<FoProject[]>([]);
  const [canSubmit, setCanSubmit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [captured, setCaptured] = useState<CapturedBlob[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error" | "info"; message: string } | null>(
    null
  );
  const [queue, setQueue] = useState<QueueSummary>({ pending: 0, syncing: 0, failed: 0, syncedRecently: 0 });
  const [isOnline, setIsOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshQueue = useCallback(async () => {
    const items = await db.syncQueue.where("userId").equals(session.id).toArray();
    const evidenceItems = items.filter((item) => item.kind === "evidence");
    const records = await db.recordsLocal.where("userId").equals(session.id).toArray();
    setQueue({
      pending: evidenceItems.filter((i) => i.status === "pending").length,
      syncing: evidenceItems.filter((i) => i.status === "syncing").length,
      failed: evidenceItems.filter((i) => i.status === "failed").length,
      syncedRecently: records.filter((r) => r.status === "synced").length,
    });
  }, [session.id]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await apiFetch("/api/projects", {
        headers: { "x-device-id": getDeviceId() },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) {
        setLoadError(body?.error || "Unable to load assigned projects.");
        setProjects([]);
        return;
      }
      setCanSubmit(body.can_submit_field_evidence === true);
      const rows = Array.isArray(body.data) ? (body.data as FoProject[]) : [];
      setProjects(rows);
      if (!selectedProjectId && rows[0]) {
        setSelectedProjectId(rows[0].id);
      }
    } catch {
      setLoadError("Unable to load assigned projects.");
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    void loadProjects();
    void refreshQueue();
  }, [loadProjects, refreshQueue]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    const tick = async () => {
      const result = await processSyncQueue(session.id);
      if (!cancelled) {
        await refreshQueue();
        if (result.authExpired) {
          setFeedback({
            tone: "error",
            message: "Session expired. Sign in again to sync queued evidence. Queued items were preserved.",
          });
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 20000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isOnline, refreshQueue, session.id]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  const milestones = useMemo(() => {
    const rows = selectedProject?.csr_project_milestones || [];
    return [...rows].sort((a, b) => Number(a.milestone_order) - Number(b.milestone_order));
  }, [selectedProject]);

  useEffect(() => {
    if (!selectedProject) {
      setSelectedMilestoneId(null);
      return;
    }
    const current = resolveCurrentFieldMilestone(milestones);
    setSelectedMilestoneId(current?.id || milestones[0]?.id || null);
  }, [selectedProject, milestones]);

  const selectedMilestone = milestones.find((m) => m.id === selectedMilestoneId) || null;

  const canCaptureSelected = useMemo(() => {
    if (!canSubmit || !selectedMilestone) return false;
    if (isLockedMilestoneStatus(selectedMilestone.status)) return false;
    if (!priorMilestonesArePaidComplete(milestones, selectedMilestone.id)) return false;
    const decision = String(selectedMilestone.latest_review?.decision || "").toLowerCase();
    if (decision === "approved") return false;
    return true;
  }, [canSubmit, selectedMilestone, milestones]);

  async function onPickFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const validation = validateEvidenceFiles([...captured.map((c) => c.blob), ...files]);
    if (validation) {
      setFeedback({ tone: "error", message: validation });
      return;
    }
    const next: CapturedBlob[] = [];
    for (const file of files) {
      const proofHash = (await calculateHash(file)).toLowerCase();
      next.push({
        name: file.name || `evidence-${Date.now()}`,
        blob: file,
        url: URL.createObjectURL(file),
        proofHash,
        kind: file.type.startsWith("video/") ? "video" : "image",
      });
    }
    setCaptured((prev) => [...prev, ...next]);
  }

  function removeCapture(index: number) {
    setCaptured((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.url);
      return prev.filter((_, i) => i !== index);
    });
  }

  async function submitEvidence() {
    if (!selectedProject || !selectedMilestone) return;
    if (!canCaptureSelected) {
      setFeedback({ tone: "error", message: "This milestone is not open for evidence submission." });
      return;
    }
    if (captured.length === 0) {
      setFeedback({ tone: "error", message: "Add at least one photo or video." });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      const coords = await getCurrentPosition();
      const recordId = randomUUID();
      const createdAt = new Date().toISOString();
      const deviceId = getDeviceId();

      const mediaEntries: LocalMediaRecord[] = [];
      for (const item of captured) {
        const actualHash = (await calculateHash(item.blob)).toLowerCase();
        if (actualHash !== item.proofHash) {
          throw new Error("Media integrity check failed. Recapture and try again.");
        }
        mediaEntries.push({
          id: randomUUID(),
          recordId,
          fileName: item.name,
          mimeType: item.blob.type || (item.kind === "video" ? "video/mp4" : "image/jpeg"),
          size: item.blob.size,
          kind: item.kind,
          blob: item.blob,
          proofHash: item.proofHash,
          createdAt,
        });
      }

      const record: LocalRecord = {
        id: recordId,
        deviceId,
        userId: session.id,
        userName: session.name,
        projectId: selectedProject.id,
        projectName: selectedProject.title,
        milestoneId: selectedMilestone.id,
        referencePointId: null,
        userType: "ngo",
        beneficiaryName: null,
        interactionType: "visit",
        notes: notes.trim(),
        gpsLat: coords?.latitude ?? null,
        gpsLng: coords?.longitude ?? null,
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
        await db.milestones.put({
          id: selectedMilestone.id,
          projectId: selectedProject.id,
          title: selectedMilestone.title,
          description: selectedMilestone.description,
          milestoneOrder: selectedMilestone.milestone_order,
          status: "submitted",
          amount: Number(selectedMilestone.amount) || 0,
          paymentReceiptUrl: null,
          ngoReceiptId: null,
          updatedAt: createdAt,
        });
      });

      captured.forEach((item) => URL.revokeObjectURL(item.url));
      setCaptured([]);
      setNotes("");
      setFeedback({
        tone: "success",
        message: isOnline
          ? "Evidence saved on this device. Upload runs while the app stays open and online."
          : "Evidence saved offline. It will upload when the app is open and online — items are not discarded.",
      });

      if (isOnline) {
        const result = await processSyncQueue(session.id);
        if (result.authExpired) {
          setFeedback({
            tone: "error",
            message: "Session expired during sync. Sign in again. Queued evidence was preserved.",
          });
        } else if (result.failed > 0 && result.succeeded === 0) {
          setFeedback({
            tone: "error",
            message: "Evidence is queued but sync failed. It will retry while the app is open.",
          });
        } else if (result.succeeded > 0) {
          setFeedback({ tone: "success", message: "Evidence submitted successfully." });
          await loadProjects();
        }
      }
      await refreshQueue();
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Unable to save evidence.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16, marginTop: 8 }}>
      <div className="form-group">
        <label>Sync status</label>
        <p className="login-status">
          {isOnline ? "Online" : "Offline"} · pending {queue.pending} · syncing {queue.syncing} · failed{" "}
          {queue.failed}
          {queue.syncedRecently > 0 ? ` · synced ${queue.syncedRecently}` : ""}
        </p>
        <p className="login-status" style={{ fontSize: 12 }}>
          Background sync is not guaranteed. Queued evidence uploads while this app is open and online.
        </p>
      </div>

      {loading ? <p className="login-status">Loading assigned projects…</p> : null}
      {loadError ? (
        <p className="login-status" style={{ color: "var(--danger, #b42318)" }}>
          {loadError}
        </p>
      ) : null}

      {!loading && projects.length === 0 && !loadError ? (
        <p className="login-status">No projects are assigned to you yet.</p>
      ) : null}

      {projects.length > 0 ? (
        <div className="form-group">
          <label htmlFor="fo-project">Assigned project</label>
          <select
            id="fo-project"
            value={selectedProjectId || ""}
            onChange={(e) => setSelectedProjectId(e.target.value || null)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {milestones.length > 0 ? (
        <div className="form-group">
          <label>Milestones</label>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {milestones.map((milestone) => {
              const reqs = requirementsList(milestone.evidence_requirements);
              const selected = milestone.id === selectedMilestoneId;
              return (
                <li key={milestone.id}>
                  <button
                    type="button"
                    className={selected ? undefined : "btn-secondary"}
                    style={{ width: "100%", textAlign: "left" }}
                    onClick={() => setSelectedMilestoneId(milestone.id)}
                  >
                    <strong>{milestone.title}</strong>
                    <div className="login-status" style={{ marginTop: 4 }}>
                      Status: {fieldMilestoneStepLabel(milestone.status)} · Review: {reviewLabel(milestone)}
                      {milestone.due_date ? ` · Due ${milestone.due_date}` : ""}
                    </div>
                    {reqs.length > 0 ? (
                      <div className="login-status" style={{ marginTop: 4 }}>
                        Evidence required: {reqs.join(", ")}
                      </div>
                    ) : (
                      <div className="login-status" style={{ marginTop: 4 }}>
                        No specific evidence requirements listed.
                      </div>
                    )}
                    {milestone.latest_review?.decision === "rejected" && milestone.latest_review.comments ? (
                      <div className="login-status" style={{ marginTop: 4, color: "var(--danger, #b42318)" }}>
                        Feedback: {milestone.latest_review.comments}
                      </div>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {selectedMilestone ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div className="form-group">
            <label htmlFor="fo-notes">Notes</label>
            <textarea
              id="fo-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What did you observe at the site?"
              disabled={!canCaptureSelected || submitting}
            />
          </div>

          <div className="form-group">
            <label>Photos / videos</label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              capture="environment"
              multiple
              hidden
              onChange={(e) => {
                void onPickFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="btn-secondary"
              disabled={!canCaptureSelected || submitting}
              onClick={() => fileInputRef.current?.click()}
            >
              Capture or upload media
            </button>
            {captured.length > 0 ? (
              <ul style={{ listStyle: "none", padding: 0, marginTop: 8, display: "grid", gap: 6 }}>
                {captured.map((item, index) => (
                  <li key={`${item.name}-${index}`} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="login-status" style={{ flex: 1 }}>
                      {item.kind}: {item.name}
                    </span>
                    <button type="button" className="btn-secondary" onClick={() => removeCapture(index)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {!canSubmit ? (
            <p className="login-status" style={{ color: "var(--danger, #b42318)" }}>
              Evidence submission is disabled for your account. Contact your NGO administrator.
            </p>
          ) : null}

          {!canCaptureSelected && canSubmit ? (
            <p className="login-status">
              This milestone is locked or waiting on a previous payment. You cannot submit new evidence yet.
            </p>
          ) : null}

          {feedback ? (
            <p
              className="login-status"
              style={{
                color:
                  feedback.tone === "error"
                    ? "var(--danger, #b42318)"
                    : feedback.tone === "success"
                      ? "var(--success, #027a48)"
                      : undefined,
              }}
            >
              {feedback.message}
            </p>
          ) : null}

          <button type="button" disabled={!canCaptureSelected || submitting} onClick={() => void submitEvidence()}>
            {submitting ? "Saving…" : "Submit milestone evidence"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
