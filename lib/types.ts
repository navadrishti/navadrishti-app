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
  createdAt: string;
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
