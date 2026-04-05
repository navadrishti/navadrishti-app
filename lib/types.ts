export type SessionRole = "field" | "manager";

export type AppSession = {
  id: string;
  name: string;
  email: string;
  role: SessionRole;
  createdAt: string;
};

export type LocalRecordStatus = "pending" | "syncing" | "synced" | "failed";
export type QueueStatus = "pending" | "syncing" | "failed";

export type MilestoneStatus = 
  | "pending"            // NGO hasn't submitted evidence
  | "submitted"          // Evidence uploaded, waiting for CA
  | "approved"           // CA approved, payment pending
  | "payment_initiated"  // CA uploaded payment receipt
  | "paid";              // NGO uploaded received receipt, UNLOCKS next

export type LocalRecord = {
  id: string;
  deviceId: string;
  userId: string;
  userName: string;
  projectId: string;
  projectName: string;
  milestoneId: string | null;
  beneficiaryName: string;
  interactionType: "visit" | "distribution" | "training" | "verification";
  notes: string;
  gpsLat: number | null;
  gpsLng: number | null;
  status: LocalRecordStatus;
  createdAtDevice: string;
  submittedAtDevice: string;
  syncedAt: string | null;
  lastError: string | null;
};

export type LocalMediaRecord = {
  id: string;
  recordId: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "video";
  blob: Blob;
  proofHash: string | null; // SHA256 of the blob for immutability check
  createdAt: string;
};

export type LocalMilestone = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  milestoneOrder: number;
  status: MilestoneStatus;
  amount: number;
  paymentReceiptUrl: string | null; // URL of CA's receipt (from sync)
  ngoReceiptId: string | null;       // ID of NGO's acknowledgement receipt
  updatedAt: string;
};

export type SyncQueueItem = {
  id: string;
  recordId: string;
  status: QueueStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SyncLogEntry = {
  id: string;
  recordId: string;
  level: "info" | "error";
  message: string;
  createdAt: string;
};

export type RemoteRecord = {
  id: string;
  sourceRecordId: string;
  immutable: true;
  receiptId: string;
  deviceId: string;
  userId: string;
  userName: string;
  projectId: string;
  projectName: string;
  milestoneId: string | null;
  beneficiaryName: string;
  interactionType: LocalRecord["interactionType"];
  notes: string;
  gpsLat: number | null;
  gpsLng: number | null;
  submittedAtDevice: string;
  receivedAtServer: string;
  syncedAt: string;
  auditStatus: "ready";
  media: LocalMediaRecord[];
};

export type LocalRecordWithMedia = LocalRecord & {
  media: LocalMediaRecord[];
};

export type CloudinaryAssetReference = {
  assetId: string;
  publicId: string;
  secureUrl: string;
  resourceType: string;
  format: string | null;
  bytes: number;
  version: string | null;
  uploadedAt: string;
  proofHash: string | null;
};

export type DraftMediaSyncStatus = "local" | "syncing" | "synced" | "failed";

export type DraftPhotoEvidence = {
  id: string;
  capturedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  deviceId: string;
  mimeType: string;
  blob: Blob;
  proofHash: string;
  lockedAt: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  syncStatus: DraftMediaSyncStatus;
  syncError: string | null;
  cloudinary: CloudinaryAssetReference | null;
};

export type DraftDocumentEvidence = {
  id: string;
  name: string;
  scannedAt: string;
  size: number;
  mimeType: string;
  blob: Blob;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  deviceId: string;
  proofHash: string;
  lockedAt: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  syncStatus: DraftMediaSyncStatus;
  syncError: string | null;
  cloudinary: CloudinaryAssetReference | null;
};

export type ProjectDraft = {
  id: string;
  ngoId: number;
  ngoName: string;
  sessionEmail: string;
  deviceId: string;
  projectId: string;
  projectTitle: string;
  milestoneId: string;
  milestoneTitle: string;
  milestoneOrder: number;
  milestoneStatus: "pending" | "submitted" | "approved" | "rejected";
  milestoneAmount: number;
  companyName: string;
  projectStatus: "ongoing" | "completed";
  acceptanceDate: string;
  progress: number;
  nextMilestone: string;
  nextMilestoneDeadline: string;
  location: string;
  summary: string;
  photos: DraftPhotoEvidence[];
  documents: DraftDocumentEvidence[];
  updatedAt: string;
};

export type SystemEventType = 
  | "EVIDENCE_SUBMITTED"
  | "PAYMENT_ACKNOWLEDGED"
  | "AUDIT_LOG"
  | "SYSTEM_ALERT";

export interface SystemEvent {
  id: string; // The payload_hash (server-computed)
  event_id: string; // Client-generated UUID for idempotency
  event_type: SystemEventType;
  entity_id: string; // e.g. projectId or milestoneId
  payload: any;
  payload_hash: string;
  prev_hash: string | null; // For event chaining
  user_id: string;
  ngo_id: number;
  device_id: string;
  timestamp: string;
}

export interface IngestionPayload {
  event_id: string;
  event_type: SystemEventType;
  entity_id: string;
  data: any;
  timestamp: string;
  proof_hash: string; // The client-side SHA256 of the raw data
}

export interface SyncApiResponse {
  ok: boolean;
  error?: string;
  eventId?: string;
  payloadHash?: string;
}
