export type SessionRole = "ngo" | "individual";

export type AppSession = {
  id: string;
  name: string;
  ngoId: number;
  ngoName: string;
  email: string;
  role: SessionRole;
  issuedAt: number;
  expiresAt: number;
  createdAt: string;
  deviceId?: string;
  avatarUrl?: string | null;
};

export type LocalRecordStatus = "pending" | "syncing" | "synced" | "failed";
export type QueueStatus = "pending" | "syncing" | "failed";
export type SyncQueueKind = "evidence" | "attendance";

export type MilestoneStatus =
  | "pending"
  | "submitted"
  | "approved"
  | "payment_initiated"
  | "paid";

export type LocalRecord = {
  id: string;
  deviceId: string;
  userId: string;
  userName: string;
  projectId: string | null;
  projectName: string;
  milestoneId: string | null;
  referencePointId?: string | null;
  userType: "ngo";
  beneficiaryName: string | null;
  interactionType: "visit" | "distribution" | "training";
  notes: string;
  gpsLat: number | null;
  gpsLng: number | null;
  status: LocalRecordStatus;
  createdAtDevice: string;
  submittedAtDevice: string;
  syncedAt: string | null;
  lastError: string | null;
};

export type ReferencePoint = {
  id: string;
  projectId: string | null;
  name: string;
  latitude: number;
  longitude: number;
  radius?: number;
  imageUrl?: string | null;
  updatedAt: string;
};

export type LocalMediaRecord = {
  id: string;
  recordId: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "video";
  blob: Blob;
  remoteUrl?: string;
  proofHash: string | null;
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
  paymentReceiptUrl: string | null;
  ngoReceiptId: string | null;
  updatedAt: string;
};

export type SyncQueueItem = {
  id: string;
  recordId: string;
  /** Owner of this queued upload — sync only runs for the active session user. */
  userId: string;
  kind: SyncQueueKind;
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

/** Cached attendance roster for offline browsing (per signed-in user). */
export type AttendanceAssignmentCache = {
  userId: string;
  updatedAt: string;
  activeCampaigns: any[];
  historyCampaigns: any[];
  activeSkills: any[];
  historySkills: any[];
};

/** Offline attendance mark waiting to upload under the same user session. */
export type AttendanceOutboxItem = {
  id: string;
  userId: string;
  assignmentId: string;
  attendanceDate: string;
  mode: "selfie" | "photo";
  latitude: number;
  longitude: number;
  accuracy: number | null;
  units: number | null;
  photoProofs: Array<{ proofHash: string; capturedAt: string }>;
  title: string;
  status: LocalRecordStatus;
  createdAt: string;
  syncedAt: string | null;
  lastError: string | null;
};

export type LocalRecordWithMedia = LocalRecord & {
  media: LocalMediaRecord[];
};

export type SystemEventType = "EVIDENCE_SUBMITTED" | "AUDIT_LOG" | "SYSTEM_ALERT";

export interface SystemEvent {
  id: string;
  event_id: string;
  event_type: SystemEventType;
  entity_id: string;
  payload: any;
  payload_hash: string;
  prev_hash: string | null;
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
  proof_hash: string;
}

export interface SyncApiResponse {
  ok: boolean;
  error?: string;
  eventId?: string;
  payloadHash?: string;
  media?: any[];
}
