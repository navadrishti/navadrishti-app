import { db } from "@/lib/db";
import { apiFetch } from "@/lib/env";
import { randomUUID } from "@/lib/crypto";
import type {
  AttendanceAssignmentCache,
  AttendanceOutboxItem,
  LocalMediaRecord,
  SyncQueueItem,
} from "@/lib/types";

export function logStep(msg: string) {
  if (typeof window !== "undefined") {
    const w = window as any;
    w.syncSteps = w.syncSteps || [];
    w.syncSteps.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (w.onSyncStep) w.onSyncStep();
  }
  console.log(msg);
}

export function logStepError(msg: string) {
  if (typeof window !== "undefined") {
    const w = window as any;
    w.syncSteps = w.syncSteps || [];
    w.syncSteps.push(`[${new Date().toLocaleTimeString()}] ERROR: ${msg}`);
    if (w.onSyncStep) w.onSyncStep();
  }
  console.error(msg);
}

const SYNC_BATCH_SIZE = 5;
const MAX_SYNC_ATTEMPTS = 10;

export type SyncRunResult = {
  processed: number;
  succeeded: number;
  failed: number;
};

function calculateBackoffMs(attempts: number) {
  const base = Math.min(30000 * 2 ** attempts, 30 * 60 * 1000);
  const jitter = Math.random() * 5000;
  return base + jitter;
}

function getLocalDateStringClient(reference: Date = new Date()) {
  const year = reference.getFullYear();
  const month = String(reference.getMonth() + 1).padStart(2, "0");
  const day = String(reference.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function resolveQueueOwner(item: SyncQueueItem): Promise<string | null> {
  if (item.userId) return item.userId;
  if (item.kind === "attendance") {
    const outbox = await db.attendanceOutbox.get(item.recordId);
    return outbox?.userId || null;
  }
  const record = await db.recordsLocal.get(item.recordId);
  return record?.userId || null;
}

async function syncEvidenceToApi(recordId: string, media: LocalMediaRecord[]) {
  const record = await db.recordsLocal.get(recordId);

  if (!record) {
    throw new Error("Local record missing.");
  }

  const createdAt = record.submittedAtDevice || new Date().toISOString();

  const payloadData = {
    beneficiaryName: record.beneficiaryName,
    interactionType: record.interactionType,
    notes: record.notes,
    projectId: record.projectId || null,
    referencePointId: record.referencePointId || null,
    userType: "ngo",
    gpsLat: record.gpsLat,
    gpsLng: record.gpsLng,
    deviceId: record.deviceId,
    userName: record.userName,
    milestoneId: record.milestoneId,
  };

  const payload = {
    event_id: randomUUID(),
    event_type: "EVIDENCE_SUBMITTED",
    entity_id: record.milestoneId || record.projectId || "unknown",
    data: payloadData,
    timestamp: createdAt,
    proof_hash: record.id,
  };

  const formData = new FormData();
  formData.append("payload", JSON.stringify(payload));

  for (const item of media) {
    formData.append("files", item.blob, item.fileName);
  }

  const response = await apiFetch("/api/evidence", {
    method: "POST",
    body: formData,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("AUTH_EXPIRED: Session expired. Sign in again to sync.");
  }

  if (response.status === 409) {
    // Idempotent success
  } else if (!response.ok) {
    let errorBody: { error?: string } = {};
    try {
      errorBody = await response.json();
    } catch {
      /* ignore */
    }
    throw new Error(errorBody.error || `Server returned ${response.status}`);
  }

  const syncedAt = new Date().toISOString();
  await db.recordsLocal.update(record.id, {
    status: "synced",
    syncedAt,
    lastError: null,
  });
}

async function syncAttendanceToApi(outboxId: string, media: LocalMediaRecord[]) {
  const item = await db.attendanceOutbox.get(outboxId);
  if (!item) throw new Error("Local attendance mark missing.");

  const form = new FormData();
  form.append("attendanceStatus", "present");
  form.append("locationLatitude", String(item.latitude));
  form.append("locationLongitude", String(item.longitude));
  if (item.accuracy != null) form.append("locationAccuracy", String(item.accuracy));
  if (item.units != null) form.append("units", String(item.units));
  form.append("photoProofs", JSON.stringify(item.photoProofs));

  for (const photo of media) {
    form.append("photos", photo.blob, photo.fileName);
  }

  const response = await apiFetch(`/api/attendance/${item.assignmentId}`, {
    method: "POST",
    body: form,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("AUTH_EXPIRED: Session expired. Sign in again to sync.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    const message = data?.error || `Server returned ${response.status}`;
    // Already marked today on server — treat as success and clear outbox
    if (response.status === 409 || /already marked/i.test(String(message))) {
      await db.attendanceOutbox.update(outboxId, {
        status: "synced",
        syncedAt: new Date().toISOString(),
        lastError: null,
      });
      return;
    }
    throw new Error(message);
  }

  await db.attendanceOutbox.update(outboxId, {
    status: "synced",
    syncedAt: new Date().toISOString(),
    lastError: null,
  });

  // Reflect mark on local cache so UI stays correct offline
  await patchAttendanceCacheMark(item.userId, item.assignmentId, item.attendanceDate);
}

async function patchAttendanceCacheMark(
  userId: string,
  assignmentId: string,
  attendanceDate: string
) {
  const cache = await db.attendanceCache.get(userId);
  if (!cache) return;

  const patchList = (items: any[]) =>
    items.map((entry) => {
      if (String(entry.assignment_id) !== String(assignmentId)) return entry;
      const days = Number(entry.attendance_summary?.days_attended ?? 0) + 1;
      return {
        ...entry,
        attendance_summary: {
          ...(entry.attendance_summary || {}),
          last_attendance_at: attendanceDate,
          days_attended: days,
          total_entries: Number(entry.attendance_summary?.total_entries ?? 0) + 1,
        },
      };
    });

  await db.attendanceCache.put({
    ...cache,
    activeCampaigns: patchList(cache.activeCampaigns || []),
    historyCampaigns: patchList(cache.historyCampaigns || []),
    activeSkills: patchList(cache.activeSkills || []),
    historySkills: patchList(cache.historySkills || []),
    updatedAt: new Date().toISOString(),
  });
}

async function failQueueItem(item: SyncQueueItem, message: string) {
  const updatedAt = new Date().toISOString();
  const attempts = item.attempts + 1;
  const isFatal =
    message.startsWith("FATAL:") ||
    message.startsWith("AUTH_EXPIRED:") ||
    attempts >= MAX_SYNC_ATTEMPTS;

  await db.syncQueue.put({
    ...item,
    status: "failed",
    attempts,
    nextAttemptAt: isFatal ? -1 : Date.now() + calculateBackoffMs(item.attempts),
    lastError: message,
    updatedAt,
  });

  if (item.kind === "attendance") {
    await db.attendanceOutbox.update(item.recordId, {
      status: "failed",
      lastError: message,
    });
  } else {
    await db.recordsLocal.update(item.recordId, {
      status: "failed",
      lastError: message,
    });
  }

  await db.syncLog.add({
    id: randomUUID(),
    recordId: item.recordId,
    level: "error",
    message: isFatal ? `[TERMINAL FAILURE] ${message}` : message,
    createdAt: updatedAt,
  });
}

/**
 * Upload queued evidence + attendance for the active signed-in user only.
 * Uses the session cookie from the same browser login.
 */
export async function processSyncQueue(sessionUserId: string): Promise<SyncRunResult> {
  if (!window.navigator.onLine) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  if (!sessionUserId) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const now = Date.now();
  const allDue = await db.syncQueue.filter((item) => item.nextAttemptAt <= now).sortBy("nextAttemptAt");

  const queue: SyncQueueItem[] = [];
  for (const item of allDue) {
    const ownerId = await resolveQueueOwner(item);
    if (ownerId && ownerId === sessionUserId) {
      // Backfill missing userId/kind on legacy queue rows
      if (!item.userId || !item.kind) {
        await db.syncQueue.update(item.id, {
          userId: ownerId,
          kind: item.kind || "evidence",
        });
      }
      queue.push({
        ...item,
        userId: ownerId,
        kind: item.kind || "evidence",
      });
    }
    if (queue.length >= SYNC_BATCH_SIZE) break;
  }

  let succeeded = 0;
  let failed = 0;

  if (queue.length > 0) {
    await db.syncLog.add({
      id: randomUUID(),
      recordId: queue[0].recordId,
      level: "info",
      message: `Starting sync batch of ${queue.length} item(s) for user ${sessionUserId}.`,
      createdAt: new Date().toISOString(),
    });
  }

  for (const item of queue) {
    try {
      await db.syncQueue.update(item.id, {
        status: "syncing",
        updatedAt: new Date().toISOString(),
      });

      const media = await db.mediaLocal.where("recordId").equals(item.recordId).toArray();

      if (item.kind === "attendance") {
        await db.attendanceOutbox.update(item.recordId, { status: "syncing", lastError: null });
        await syncAttendanceToApi(item.recordId, media);
        await db.mediaLocal.where("recordId").equals(item.recordId).delete();
        await db.attendanceOutbox.delete(item.recordId);
      } else {
        await db.recordsLocal.update(item.recordId, { status: "syncing", lastError: null });
        await syncEvidenceToApi(item.recordId, media);
      }

      await db.syncQueue.delete(item.id);
      await db.syncLog.add({
        id: randomUUID(),
        recordId: item.recordId,
        level: "info",
        message:
          item.kind === "attendance"
            ? "Attendance synced to server."
            : "Evidence synced and server receipt confirmed.",
        createdAt: new Date().toISOString(),
      });
      succeeded += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "Unknown sync failure.";
      await failQueueItem(item, message);

      if (message.startsWith("AUTH_EXPIRED:")) {
        break;
      }
    }
  }

  return {
    processed: queue.length,
    succeeded,
    failed,
  };
}

/** Pull CSR projects + milestones for the signed-in NGO. */
export async function pullProjectData(): Promise<void> {
  if (!window.navigator.onLine) return;

  try {
    const res = await apiFetch("/api/projects");
    if (!res.ok) throw new Error(`Fetch projects failed: ${res.status}`);

    const result = await res.json();
    const projects = result.data;
    if (!Array.isArray(projects)) return;

    await db.transaction("rw", [db.milestones, db.referencePoints], async () => {
      await db.milestones.clear();
      await db.referencePoints.clear();

      for (const project of projects) {
        if (Array.isArray(project.csr_project_milestones)) {
          const milestones = project.csr_project_milestones.map((ms: any) => ({
            id: ms.id,
            projectId: project.id,
            title: ms.title,
            description: ms.description || "",
            milestoneOrder: ms.milestone_order,
            amount: ms.amount,
            status: ms.status || "pending",
            paymentReceiptUrl: null,
            ngoReceiptId: null,
            updatedAt: new Date().toISOString(),
          }));
          await db.milestones.bulkPut(milestones);
        }

        if (Array.isArray(project.reference_points)) {
          const refPoints = project.reference_points.map((rp: any) => ({
            id: rp.id,
            projectId: project.id,
            name: rp.name,
            latitude: rp.latitude,
            longitude: rp.longitude,
            radius: Number(rp.radius_meters ?? rp.radius ?? 100) || 100,
            updatedAt: rp.updated_at || new Date().toISOString(),
          }));
          await db.referencePoints.bulkPut(refPoints);
        }
      }
    });

    console.log(`[SYNC_ENGINE] Successfully pulled ${projects.length} projects.`);
  } catch (err) {
    console.error("[SYNC_ENGINE] Pull failed:", err);
    throw err;
  }
}

export async function saveAttendanceCache(
  userId: string,
  payload: Omit<AttendanceAssignmentCache, "userId" | "updatedAt">
) {
  await db.attendanceCache.put({
    userId,
    updatedAt: new Date().toISOString(),
    ...payload,
  });
}

export async function readAttendanceCache(userId: string) {
  return db.attendanceCache.get(userId);
}

/** Merge pending local marks into roster so offline UI shows "already marked today". */
export async function applyPendingAttendanceOverlay(
  userId: string,
  lists: {
    activeCampaigns: any[];
    historyCampaigns: any[];
    activeSkills: any[];
    historySkills: any[];
  }
) {
  const today = getLocalDateStringClient();
  const pending = await db.attendanceOutbox
    .where("userId")
    .equals(userId)
    .filter((row) => row.status !== "synced" && row.attendanceDate === today)
    .toArray();

  if (pending.length === 0) return lists;

  const byAssignment = new Map(pending.map((row) => [String(row.assignmentId), row]));

  const patch = (items: any[]) =>
    items.map((item) => {
      const mark = byAssignment.get(String(item.assignment_id));
      if (!mark) return item;
      return {
        ...item,
        attendance_summary: {
          ...(item.attendance_summary || {}),
          last_attendance_at: today,
          days_attended: Number(item.attendance_summary?.days_attended ?? 0),
          pending_sync: true,
        },
      };
    });

  return {
    activeCampaigns: patch(lists.activeCampaigns),
    historyCampaigns: patch(lists.historyCampaigns),
    activeSkills: patch(lists.activeSkills),
    historySkills: patch(lists.historySkills),
  };
}

export async function enqueueAttendanceMark(input: {
  userId: string;
  assignmentId: string;
  mode: "selfie" | "photo";
  latitude: number;
  longitude: number;
  accuracy: number | null;
  units: number | null;
  title: string;
  photos: Array<{ blob: Blob; name: string; proofHash: string; capturedAt: string }>;
}) {
  const today = getLocalDateStringClient();
  const existing = await db.attendanceOutbox
    .where("userId")
    .equals(input.userId)
    .filter(
      (row) =>
        row.assignmentId === input.assignmentId &&
        row.attendanceDate === today &&
        row.status !== "synced"
    )
    .first();

  if (existing) {
    throw new Error("Today's attendance is already saved on this device (waiting to sync).");
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const outbox: AttendanceOutboxItem = {
    id,
    userId: input.userId,
    assignmentId: input.assignmentId,
    attendanceDate: today,
    mode: input.mode,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy: input.accuracy,
    units: input.units,
    photoProofs: input.photos.map((photo) => ({
      proofHash: photo.proofHash,
      capturedAt: photo.capturedAt,
    })),
    title: input.title,
    status: "pending",
    createdAt,
    syncedAt: null,
    lastError: null,
  };

  const media: LocalMediaRecord[] = input.photos.map((photo) => ({
    id: randomUUID(),
    recordId: id,
    fileName: photo.name,
    mimeType: photo.blob.type || "image/jpeg",
    size: photo.blob.size,
    kind: "image" as const,
    blob: photo.blob,
    proofHash: photo.proofHash,
    createdAt,
  }));

  await db.transaction("rw", [db.attendanceOutbox, db.mediaLocal, db.syncQueue], async () => {
    await db.attendanceOutbox.put(outbox);
    await db.mediaLocal.bulkPut(media);
    await db.syncQueue.put({
      id,
      recordId: id,
      userId: input.userId,
      kind: "attendance",
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    });
  });

  await patchAttendanceCacheMark(input.userId, input.assignmentId, today);

  return outbox;
}
