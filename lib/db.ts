import Dexie, { type Table } from "dexie";
import type {
  LocalMediaRecord,
  LocalMilestone,
  LocalRecord,
  ProjectDraft,
  ReferencePoint,
  RemoteRecord,
  SyncLogEntry,
  SyncQueueItem,
  AwcSite,
} from "@/lib/types";

class NavadrishtiDB extends Dexie {
  recordsLocal!: Table<LocalRecord, string>;
  mediaLocal!: Table<LocalMediaRecord, string>;
  syncQueue!: Table<SyncQueueItem, string>;
  syncLog!: Table<SyncLogEntry, string>;
  remoteRecords!: Table<RemoteRecord, string>;
  projectDrafts!: Table<ProjectDraft, string>;
  milestones!: Table<LocalMilestone, string>;
  referencePoints!: Table<ReferencePoint, string>;
  awcSites!: Table<AwcSite, string>;

  constructor() {
    super("navadrishti-field-db");

    // Versions 1-7 ...
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

    this.version(7).stores({
      recordsLocal: "id, deviceId, status, userId, projectId, referencePointId, userType, geoValidated, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer",
      projectDrafts: "id, ngoId, projectId, updatedAt",
      milestones: "id, projectId, milestoneOrder, status",
      referencePoints: "id, projectId, name"
    });

    this.version(8).stores({
      recordsLocal: "id, deviceId, status, userId, projectId, siteId, referencePointId, userType, geoValidated, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer",
      projectDrafts: "id, ngoId, projectId, updatedAt",
      milestones: "id, projectId, milestoneOrder, status",
      referencePoints: "id, projectId, siteId, name",
      awcSites: "id, district, block, updatedAt"
    }).upgrade(tx => {
      // Migration: Backfill legacy records as NGO domain
      return tx.table("recordsLocal").toCollection().modify(record => {
        if (!record.userType) record.userType = "ngo";
        if (record.siteId === undefined) record.siteId = null;
      });
    });

    this.version(9).stores({
      recordsLocal: "id, deviceId, status, userId, projectId, siteId, referencePointId, userType, geoValidated, submittedAtDevice",
      mediaLocal: "id, recordId, kind, createdAt",
      syncQueue: "id, recordId, status, nextAttemptAt, attempts",
      syncLog: "id, recordId, createdAt",
      remoteRecords: "id, &sourceRecordId, projectId, syncedAt, submittedAtDevice, receivedAtServer",
      projectDrafts: "id, ngoId, projectId, updatedAt",
      milestones: "id, projectId, milestoneOrder, status",
      referencePoints: "id, projectId, siteId, name",
      awcSites: "id, district, block, updatedAt"
    });

    this.on("blocked", () => {
      console.warn("[Dexie] Database upgrade blocked! Please close other tabs of this app.");
    });
  }
}

export const db = new NavadrishtiDB();
