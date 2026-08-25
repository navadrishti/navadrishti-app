import { db } from "@/lib/db";
import { apiFetch } from "@/lib/env";
import { randomUUID } from "@/lib/crypto";
import type { LocalMediaRecord, SyncQueueItem } from "@/lib/types";

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

async function syncRecordToApi(recordId: string, media: LocalMediaRecord[]) {
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

  if (!response.ok) {
    if (response.status === 409) {
      const syncedAt = new Date().toISOString();
      await db.recordsLocal.update(record.id, { status: "synced", syncedAt, lastError: null });
      return;
    }

    const errorBody = await response.json().catch(() => ({ error: "Sync failed" }));

    if (response.status === 400 || response.status === 403 || response.status === 404) {
      throw new Error(`FATAL: ${errorBody.error}`);
    }

    if (response.status === 401) {
      throw new Error(`AUTH_EXPIRED: Please sign in again.`);
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

  await db.recordsLocal.update(item.recordId, {
    status: "failed",
    lastError: message,
  });

  await db.syncLog.add({
    id: randomUUID(),
    recordId: item.recordId,
    level: "error",
    message: isFatal ? `[TERMINAL FAILURE] ${message}` : message,
    createdAt: updatedAt,
  });
}

export async function processSyncQueue(): Promise<SyncRunResult> {
  if (!window.navigator.onLine) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const now = Date.now();
  const queue = (
    await db.syncQueue.filter((item) => item.nextAttemptAt <= now).sortBy("nextAttemptAt")
  ).slice(0, SYNC_BATCH_SIZE);

  let succeeded = 0;
  let failed = 0;

  if (queue.length > 0) {
    await db.syncLog.add({
      id: randomUUID(),
      recordId: queue[0].recordId,
      level: "info",
      message: `Starting sync batch of ${queue.length} queued record(s).`,
      createdAt: new Date().toISOString(),
    });
  }

  for (const item of queue) {
    try {
      await db.syncQueue.update(item.id, {
        status: "syncing",
        updatedAt: new Date().toISOString(),
      });
      await db.recordsLocal.update(item.recordId, { status: "syncing", lastError: null });

      const media = await db.mediaLocal.where("recordId").equals(item.recordId).toArray();
      await syncRecordToApi(item.recordId, media);
      await db.syncQueue.delete(item.id);
      await db.syncLog.add({
        id: randomUUID(),
        recordId: item.recordId,
        level: "info",
        message: "Record synced and server receipt confirmed.",
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
            radius: 100,
            updatedAt: new Date().toISOString(),
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
