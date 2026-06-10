import { db } from "@/lib/db";
import type { LocalMediaRecord, RemoteRecord, SyncQueueItem } from "@/lib/types";

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

  const createdAt = record.submittedAtDevice || new Date().toISOString();

  // Explicitly map payload to avoid spreading and ensure domain separation
  const payloadData = {
    beneficiaryName: record.beneficiaryName,
    interactionType: record.interactionType,
    notes: record.notes,
    projectId: record.projectId || null,
    siteId: record.siteId || null,
    referencePointId: record.referencePointId || null,
    userType: record.userType,
    geoDistance: record.geoDistance,
    geoValidated: record.geoValidated,
    gpsLat: record.gpsLat,
    gpsLng: record.gpsLng,
    deviceId: record.deviceId,
    userName: record.userName,
    milestoneId: record.milestoneId
  };

  // Prepare Form Data (Multipart)
  const payload = {
    event_id: crypto.randomUUID(),
    event_type: "EVIDENCE_SUBMITTED",
    entity_id: record.siteId || record.milestoneId || record.projectId || "unknown",
    data: payloadData,
    timestamp: createdAt,
    proof_hash: record.id
  };

  const formData = new FormData();
  formData.append("payload", JSON.stringify(payload));
  
  for (const item of media) {
    formData.append("files", item.blob, item.fileName);
  }

  // 3. Perform Sync
  const response = await fetch("/api/evidence", {
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

  // 5. Populate Remote Mirror for Manager/Review
  await db.remoteRecords.put({
    id: result.eventId,
    sourceRecordId: record.id,
    immutable: true,
    receiptId: result.payloadHash,
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
    syncedAt: syncedAt,
    auditStatus: "ready",
    media: media.map((m, idx) => ({ 
      ...m, 
      blob: m.blob,
      remoteUrl: result.media?.[idx]?.url // Assuming result returns the media array
    }))
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

/**
 * NGO-only: Fetches CSR projects and milestones.
 */
export async function pullProjectData(): Promise<void> {
  if (!window.navigator.onLine) return;

  try {
    const res = await fetch("/api/projects");
    if (!res.ok) throw new Error(`Fetch projects failed: ${res.status}`);
    
    const result = await res.json();
    const projects = result.data;
    if (!Array.isArray(projects)) return;

    await db.transaction("rw", [db.milestones, db.referencePoints], async () => {
      await db.milestones.clear();
      const ngoKeys = await db.referencePoints.filter(rp => !!rp.projectId).primaryKeys();
      await db.referencePoints.bulkDelete(ngoKeys);

      for (const project of projects) {
        // 1. Process Milestones
        if (Array.isArray(project.csr_project_milestones)) {
          const milestones = project.csr_project_milestones.map((ms: any) => ({
            id: ms.id,
            projectId: project.id,
            title: ms.title,
            description: ms.description || "",
            milestoneOrder: ms.milestone_order,
            amount: ms.amount,
            status: ms.status || "pending",
            evidenceRequirements: ms.evidence_requirements || [],
            dueDate: ms.due_date || null,
            updatedAt: new Date().toISOString()
          }));
          await db.milestones.bulkPut(milestones);
        }

        // 2. Process Reference Points
        if (Array.isArray(project.reference_points)) {
          const refPoints = project.reference_points.map((rp: any) => ({
            id: rp.id,
            projectId: project.id,
            name: rp.name,
            latitude: rp.latitude,
            longitude: rp.longitude,
            radius: 100 // Default 100m radius
          }));
          await db.referencePoints.bulkPut(refPoints);
        }
      }
    });

    console.log(`[SYNC_ENGINE] Successfully pulled ${projects.length} projects.`);
    
    // After pulling projects, also pull remote evidence for those projects
    await pullRemoteRecords();
  } catch (err) {
    console.error("[SYNC_ENGINE] Pull failed:", err);
    throw err;
  }
}

/**
 * GOV-only: Fetches AWC site data.
 */
export async function pullAwcData(): Promise<void> {
  logStep("pullAwcData: Started");
  if (!window.navigator.onLine) {
    logStepError("pullAwcData: Device is offline according to navigator.onLine");
    return;
  }

  try {
    logStep("pullAwcData: Fetching /api/projects");
    const res = await fetch("/api/projects");
    logStep(`pullAwcData: Fetch responded with status ${res.status}`);
    if (!res.ok) {
      logStepError(`pullAwcData: Fetch returned error status: ${res.status}`);
      return;
    }

    const result = await res.json();
    logStep(`pullAwcData: JSON parsed, ok = ${result.ok}, role = ${result.role}`);
    const sites = result.data;
    if (!Array.isArray(sites)) {
      logStepError("pullAwcData: Result data is not an array");
      return;
    }
    logStep(`pullAwcData: Found ${sites.length} sites in response`);

    logStep("pullAwcData: Starting db transaction");
    await db.transaction("rw", [db.awcSites, db.referencePoints], async () => {
      logStep("pullAwcData: Clearing awcSites");
      await db.awcSites.clear();
      
      logStep("pullAwcData: Filtering reference points to delete");
      const govKeys = await db.referencePoints
        .filter(rp => !!rp.siteId)
        .primaryKeys();
      logStep(`pullAwcData: Deleting ${govKeys.length} GOV reference points`);
      await db.referencePoints.bulkDelete(govKeys);

      logStep("pullAwcData: Putting sites and reference points to DB");
      for (const site of sites) {
        await db.awcSites.put({
          id: site.id,
          name: site.name,
          district: site.district,
          block: site.block,
          state: site.state,
          address: site.address,
          isActive: true,
          referencePoints: [],
          updatedAt: site.updated_at
        });

        if (Array.isArray(site.reference_points)) {
          const refPoints = site.reference_points.map((rp: any) => ({
            id: rp.id,
            projectId: null,
            siteId: rp.site_id,
            name: rp.name,
            latitude: rp.latitude,
            longitude: rp.longitude,
            radius: rp.radius_meters ?? 100,
            imageUrl: rp.image_url ?? null,
            updatedAt: new Date().toISOString()
          }));
          await db.referencePoints.bulkPut(refPoints);
        }
      }
    });

    logStep(`pullAwcData: Transaction completed. Successfully pulled ${sites.length} AWC sites.`);
  } catch (err: any) {
    logStepError(`pullAwcData: Failed with crash: ${err?.message || String(err)}`);
  }
}

/**
 * Fetches existing evidence events from the server to populate the manager dashboard.
 */
export async function pullRemoteRecords() {
  if (!window.navigator.onLine) return;

  try {
    const res = await fetch("/api/sync/evidence/history");
    if (!res.ok) return;

    const { events } = await res.json();
    if (!Array.isArray(events)) return;

    await db.transaction("rw", [db.remoteRecords], async () => {
      for (const event of events) {
        const data = event.payload;
        await db.remoteRecords.put({
          id: event.id,
          sourceRecordId: data.recordId || event.event_id,
          immutable: true,
          receiptId: event.payload_hash,
          deviceId: event.device_id,
          userId: event.user_id,
          userName: data.userName || event.user_id,
          projectId: data.projectId,
          projectName: data.projectName || "Project",
          milestoneId: data.milestoneId,
          beneficiaryName: data.beneficiaryName || "Unknown",
          interactionType: data.interactionType || "visit",
          notes: data.notes || "",
          gpsLat: data.gpsLat,
          gpsLng: data.gpsLng,
          submittedAtDevice: data.submittedAtDevice || event.timestamp,
          receivedAtServer: event.timestamp,
          syncedAt: new Date().toISOString(),
          auditStatus: "ready",
          media: (data.media || []).map((m: any) => ({
             id: m.asset_id,
             recordId: event.id,
             fileName: "Remote Asset",
             mimeType: "image/jpeg",
             size: m.bytes || 0,
             kind: "image",
             blob: new Blob([]),
             remoteUrl: m.url,
             proofHash: m.proofHash || null,
             createdAt: event.timestamp
          }))
        });
      }
    });
    console.log(`[SYNC_ENGINE] Successfully synced ${events.length} remote evidence records.`);
  } catch (err) {
    console.error("[SYNC_ENGINE] Pull remote records failed:", err);
  }
}
