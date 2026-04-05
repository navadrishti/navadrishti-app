import { db } from "@/lib/db";
import type { LocalMediaRecord, RemoteRecord, SyncQueueItem } from "@/lib/types";

const SYNC_BATCH_SIZE = 5;
const MAX_SYNC_ATTEMPTS = 10;

export type SyncRunResult = {
  processed: number;
  succeeded: number;
  failed: number;
};

function calculateBackoffMs(attempts: number) {
  const base = Math.min(30000 * 2 ** attempts, 30 * 60 * 1000);
  const jitter = Math.random() * 5000; // Add up to 5s of jitter
  return base + jitter;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function syncRecordToApi(recordId: string, media: LocalMediaRecord[]) {
  const record = await db.recordsLocal.get(recordId);

  if (!record) {
    throw new Error("Local record missing.");
  }

  // 1. Prepare Metadata Payload
  const payload = {
    event_id: crypto.randomUUID(),
    event_type: "EVIDENCE_SUBMITTED",
    entity_id: record.milestoneId || "unassigned",
    data: {
      recordId: record.id,
      deviceId: record.deviceId,
      userId: record.userId,
      userName: record.userName,
      projectId: record.projectId,
      projectName: record.projectName,
      milestoneId: record.milestoneId,
      beneficiaryName: record.beneficiaryName,
      interactionType: record.interactionType,
      notes: record.notes,
      gpsLat: record.gpsLat,
      gpsLng: record.gpsLng,
      submittedAtDevice: record.submittedAtDevice,
      proofHashes: media.map(m => m.proofHash)
    },
    timestamp: new Date().toISOString(),
    proof_hash: record.id // Simple correlation ID for the PWA
  };

  // 2. Prepare Form Data (Multipart)
  const formData = new FormData();
  formData.append("payload", JSON.stringify(payload));
  
  for (const item of media) {
    formData.append("files", item.blob, item.fileName);
  }

  // 3. Perform Sync
  const response = await fetch("/api/sync/evidence", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    if (response.status === 409) {
       // Idempotency Success: Record is already on the server
       const result = await response.json();
       const syncedAt = new Date().toISOString();
       await db.recordsLocal.update(record.id, { status: "synced", syncedAt, lastError: null });
       return;
    }

    const errorBody = await response.json().catch(() => ({ error: "Sync failed" }));
    
    // Check for non-retryable errors
    if (response.status === 400 || response.status === 403 || response.status === 404) {
       throw new Error(`FATAL: ${errorBody.error}`);
    }

    if (response.status === 401) {
       throw new Error(`AUTH_EXPIRED: Please sign in again.`);
    }
    
    throw new Error(errorBody.error || `Server returned ${response.status}`);
  }

  const result = await response.json();
  const syncedAt = new Date().toISOString();

  // 4. Update Local State
  await db.recordsLocal.update(record.id, { 
    status: "synced", 
    syncedAt, 
    lastError: null 
  });
}

async function failQueueItem(item: SyncQueueItem, message: string) {
  const updatedAt = new Date().toISOString();
  const attempts = item.attempts + 1;
  const isFatal = message.startsWith("FATAL:") || message.startsWith("AUTH_EXPIRED:") || attempts >= MAX_SYNC_ATTEMPTS;

  await db.syncQueue.put({
    ...item,
    status: "failed",
    attempts,
    nextAttemptAt: isFatal ? -1 : Date.now() + calculateBackoffMs(item.attempts), // -1 means terminal failure
    lastError: message,
    updatedAt
  });

  await db.recordsLocal.update(item.recordId, {
    status: "failed",
    lastError: message
  });

  await db.syncLog.add({
    id: crypto.randomUUID(),
    recordId: item.recordId,
    level: "error",
    message: isFatal ? `[TERMINAL FAILURE] ${message}` : message,
    createdAt: updatedAt
  });
}

export async function processSyncQueue(): Promise<SyncRunResult> {
  if (!window.navigator.onLine) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const now = Date.now();
  const queue = (await db.syncQueue
    .filter((item) => item.nextAttemptAt <= now)
    .sortBy("nextAttemptAt")).slice(0, SYNC_BATCH_SIZE);

  let succeeded = 0;
  let failed = 0;

  if (queue.length > 0) {
    await db.syncLog.add({
      id: crypto.randomUUID(),
      recordId: queue[0].recordId,
      level: "info",
      message: `Starting sync batch of ${queue.length} queued record(s).`,
      createdAt: new Date().toISOString()
    });
  }

  for (const item of queue) {
    try {
      await db.syncQueue.update(item.id, {
        status: "syncing",
        updatedAt: new Date().toISOString()
      });
      await db.recordsLocal.update(item.recordId, { status: "syncing", lastError: null });

      const media = await db.mediaLocal.where("recordId").equals(item.recordId).toArray();
      await syncRecordToApi(item.recordId, media);
      await db.syncQueue.delete(item.id);
      await db.syncLog.add({
        id: crypto.randomUUID(),
        recordId: item.recordId,
        level: "info",
        message: "Record synced and server receipt confirmed.",
        createdAt: new Date().toISOString()
      });
      succeeded += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "Unknown sync failure.";
      await failQueueItem(item, message);

      if (message.startsWith("AUTH_EXPIRED:")) {
        break; // Stop batch processing if authentication is gone
      }
    }
  }

  return {
    processed: queue.length,
    succeeded,
    failed
  };
}
