import { db } from "@/lib/db";
import type { LocalMediaRecord, RemoteRecord, SyncQueueItem } from "@/lib/types";

const SYNC_BATCH_SIZE = 5;

export type SyncRunResult = {
  processed: number;
  succeeded: number;
  failed: number;
};

function calculateBackoffMs(attempts: number) {
  return Math.min(30000 * 2 ** attempts, 30 * 60 * 1000);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function mirrorRecordToRemote(recordId: string, media: LocalMediaRecord[]) {
  const record = await db.recordsLocal.get(recordId);

  if (!record) {
    throw new Error("Local record missing.");
  }

  const existing = await db.remoteRecords.where("sourceRecordId").equals(record.id).first();
  if (existing) {
    await db.recordsLocal.update(record.id, {
      status: "synced",
      syncedAt: existing.syncedAt,
      lastError: null
    });
    return;
  }

  const syncedAt = new Date().toISOString();
  const remoteRecord: RemoteRecord = {
    id: `remote:${record.id}`,
    sourceRecordId: record.id,
    immutable: true,
    receiptId: `rcpt-${record.id}`,
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
    receivedAtServer: syncedAt,
    syncedAt,
    auditStatus: "ready",
    media
  };

  await sleep(450);
  await db.remoteRecords.put(remoteRecord);
  await db.recordsLocal.update(record.id, { status: "synced", syncedAt, lastError: null });
}

async function failQueueItem(item: SyncQueueItem, message: string) {
  const updatedAt = new Date().toISOString();
  const attempts = item.attempts + 1;

  await db.syncQueue.put({
    ...item,
    status: "failed",
    attempts,
    nextAttemptAt: Date.now() + calculateBackoffMs(item.attempts),
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
    message,
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
      await mirrorRecordToRemote(item.recordId, media);
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
      await failQueueItem(item, error instanceof Error ? error.message : "Unknown sync failure.");
    }
  }

  return {
    processed: queue.length,
    succeeded,
    failed
  };
}
