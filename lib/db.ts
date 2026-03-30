import Dexie, { type Table } from "dexie";
import type {
  LocalMediaRecord,
  LocalMilestone,
  LocalRecord,
  ProjectDraft,
  RemoteRecord,
  SyncLogEntry,
  SyncQueueItem,
} from "@/lib/types";

class NavadrishtiDB extends Dexie {
  recordsLocal!: Table<LocalRecord, string>;
  mediaLocal!: Table<LocalMediaRecord, string>;
  syncQueue!: Table<SyncQueueItem, string>;
  syncLog!: Table<SyncLogEntry, string>;
  remoteRecords!: Table<RemoteRecord, string>;
  projectDrafts!: Table<ProjectDraft, string>;
  milestones!: Table<LocalMilestone, string>;

  constructor() {
    super("navadrishti-field-db");

    this.version(1).stores({
      recordsLocal: "id, status, userId, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, sourceRecordId, syncedAt, submittedAtDevice"
    });

    this.version(2).stores({
      recordsLocal: "id, deviceId, status, userId, projectId, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer"
    });

    this.version(3).stores({
      recordsLocal: "id, deviceId, status, userId, projectId, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer",
      projectDrafts: "id, ngoId, projectId, updatedAt"
    });

    this.version(5).stores({
      recordsLocal: "id, deviceId, status, userId, projectId, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer",
      projectDrafts: "id, ngoId, projectId, updatedAt",
      milestones: "id, projectId, milestoneOrder, status"
    });
  }
}

export const db = new NavadrishtiDB();
