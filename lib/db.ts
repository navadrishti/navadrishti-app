import Dexie, { type Table } from "dexie";
import type {
  AttendanceAssignmentCache,
  AttendanceOutboxItem,
  LocalMediaRecord,
  LocalMilestone,
  LocalRecord,
  ReferencePoint,
  SyncLogEntry,
  SyncQueueItem,
} from "@/lib/types";

class NavadrishtiDB extends Dexie {
  recordsLocal!: Table<LocalRecord, string>;
  mediaLocal!: Table<LocalMediaRecord, string>;
  syncQueue!: Table<SyncQueueItem, string>;
  syncLog!: Table<SyncLogEntry, string>;
  milestones!: Table<LocalMilestone, string>;
  referencePoints!: Table<ReferencePoint, string>;
  attendanceCache!: Table<AttendanceAssignmentCache, string>;
  attendanceOutbox!: Table<AttendanceOutboxItem, string>;

  constructor() {
    super("navadrishti-field-db");

    this.version(1).stores({
      recordsLocal: "id, status, userId, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, sourceRecordId, syncedAt, submittedAtDevice",
    });

    this.version(2).stores({
      recordsLocal: "id, deviceId, status, userId, projectId, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer",
    });

    this.version(3).stores({
      recordsLocal: "id, deviceId, status, userId, projectId, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer",
      projectDrafts: "id, ngoId, projectId, updatedAt",
    });

    this.version(7).stores({
      recordsLocal:
        "id, deviceId, status, userId, projectId, referencePointId, userType, geoValidated, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer",
      projectDrafts: "id, ngoId, projectId, updatedAt",
      milestones: "id, projectId, milestoneOrder, status",
      referencePoints: "id, projectId, name",
    });

    this.version(8).stores({
      recordsLocal:
        "id, deviceId, status, userId, projectId, siteId, referencePointId, userType, geoValidated, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer",
      projectDrafts: "id, ngoId, projectId, updatedAt",
      milestones: "id, projectId, milestoneOrder, status",
      referencePoints: "id, projectId, siteId, name",
      awcSites: "id, district, block, updatedAt",
    });

    this.version(9).stores({
      recordsLocal:
        "id, deviceId, status, userId, projectId, siteId, referencePointId, userType, geoValidated, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer",
      projectDrafts: "id, ngoId, projectId, updatedAt",
      milestones: "id, projectId, milestoneOrder, status",
      referencePoints: "id, projectId, siteId, name",
      awcSites: "id, district, block, updatedAt",
    });

    this.version(10).stores({
      recordsLocal: "id, deviceId, status, userId, projectId, milestoneId, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      milestones: "id, projectId, milestoneOrder, status",
      referencePoints: "id, projectId, name",
      remoteRecords: null,
      projectDrafts: null,
      awcSites: null,
    });

    this.version(11).stores({
      recordsLocal: "id, deviceId, status, userId, projectId, milestoneId, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, userId, kind, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      milestones: "id, projectId, milestoneOrder, status",
      referencePoints: "id, projectId, name",
      attendanceCache: "userId, updatedAt",
      attendanceOutbox: "id, userId, assignmentId, attendanceDate, status",
    });

    this.on("blocked", () => {
      console.warn("[Dexie] Database upgrade blocked! Please close other tabs of this app.");
    });
  }
}

export const db = new NavadrishtiDB();
