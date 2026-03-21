"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useAppContext } from "@/components/app-provider";
import { MediaPreview } from "@/components/media-preview";
import { db } from "@/lib/db";
import { getDeviceId } from "@/lib/device";
import type { LocalMediaRecord, LocalRecordWithMedia } from "@/lib/types";

async function getCurrentPosition() {
  if (!("geolocation" in navigator)) {
    return null;
  }

  return new Promise<{ latitude: number; longitude: number } | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusPill({ status }: { status: LocalRecordWithMedia["status"] }) {
  return <span className={`pill ${status}`}>{status}</span>;
}

export function FieldConsole() {
  const { ready, session, isOnline, isSyncing, syncNow, signOut } = useAppContext();
  const [projectId, setProjectId] = useState("PRJ-NAVA-001");
  const [projectName, setProjectName] = useState("Ward upgrade evidence");
  const [milestoneId, setMilestoneId] = useState("MS-01");
  const [beneficiaryName, setBeneficiaryName] = useState("Uma Devi");
  const [interactionType, setInteractionType] = useState<LocalRecordWithMedia["interactionType"]>("visit");
  const [notes, setNotes] = useState("Completed plumbing repair and handed over final walkthrough.");
  const [captureGps, setCaptureGps] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [submitState, setSubmitState] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deviceId] = useState(() => getDeviceId());

  const records = useLiveQuery(async () => {
    const localRecords = await db.recordsLocal.orderBy("submittedAtDevice").reverse().toArray();
    const media = await db.mediaLocal.toArray();

    return localRecords.map<LocalRecordWithMedia>((record) => ({
      ...record,
      media: media.filter((item) => item.recordId === record.id)
    }));
  }, [], []);

  const stats = useLiveQuery(async () => {
    const allRecords = await db.recordsLocal.toArray();
    const pending = allRecords.filter((item) => item.status === "pending" || item.status === "syncing").length;
    const synced = allRecords.filter((item) => item.status === "synced").length;
    const failed = allRecords.filter((item) => item.status === "failed").length;
    const mediaCount = await db.mediaLocal.count();

    return { pending, synced, failed, mediaCount };
  }, [], { pending: 0, synced: 0, failed: 0, mediaCount: 0 });

  const queuedBytes = useMemo(() => files.reduce((total, file) => total + file.size, 0), [files]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session || session.role !== "field") {
      return;
    }

    setSubmitting(true);
    setSubmitState(null);

    try {
      const coords = captureGps ? await getCurrentPosition() : null;
      const recordId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const mediaEntries: LocalMediaRecord[] = files.map((file) => ({
        id: crypto.randomUUID(),
        recordId,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind: file.type.startsWith("video/") ? "video" : "image",
        blob: file,
        createdAt
      }));

      await db.transaction("rw", db.recordsLocal, db.mediaLocal, db.syncQueue, db.syncLog, async () => {
        await db.recordsLocal.add({
          id: recordId,
          deviceId,
          userId: session.id,
          userName: session.name,
          projectId: projectId.trim(),
          projectName: projectName.trim(),
          milestoneId: milestoneId.trim() ? milestoneId.trim() : null,
          beneficiaryName: beneficiaryName.trim(),
          interactionType,
          notes: notes.trim(),
          gpsLat: coords?.latitude ?? null,
          gpsLng: coords?.longitude ?? null,
          status: "pending",
          createdAtDevice: createdAt,
          submittedAtDevice: createdAt,
          syncedAt: null,
          lastError: null
        });

        if (mediaEntries.length > 0) {
          await db.mediaLocal.bulkAdd(mediaEntries);
        }

        await db.syncQueue.put({
          id: recordId,
          recordId,
          status: "pending",
          attempts: 0,
          nextAttemptAt: Date.now(),
          lastError: null,
          createdAt,
          updatedAt: createdAt
        });

        await db.syncLog.add({
          id: crypto.randomUUID(),
          recordId,
          level: "info",
          message: "Record queued for sync.",
          createdAt
        });
      });

      setFiles([]);
      setNotes("");
      setSubmitState("Submission saved on the device with GPS, timestamp, user ID, project ID, and device ID queued for sync.");

      if (isOnline) {
        await syncNow();
      }
    } catch (error) {
      setSubmitState(error instanceof Error ? error.message : "Could not save the submission.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!ready) {
    return <main className="shell"><section className="panel">Loading field workspace...</section></main>;
  }

  if (!session || session.role !== "field") {
    return (
      <main className="shell">
        <section className="panel">
          <span className="eyebrow">Restricted</span>
          <h2>Field access requires a field session.</h2>
          <p className="subtle">Sign in from the home page as a field user to capture evidence offline.</p>
          <div className="cta-row">
            <Link className="button button-primary" href="/">
              Return home
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell field-layout">
      <header className="site-header">
        <Link className="brand" href="/">
          <img className="brand-mark" src="/logo.svg" alt="Navadrishti logo" />
          <span>Field console</span>
        </Link>
        <div className="nav-row">
          <span className={`status-chip ${isOnline ? "online" : "offline"}`}>{isOnline ? "Online" : "Offline"}</span>
          <span className="role-chip">Signed in as {session.name}</span>
          <span className="role-chip mono">Device {deviceId.slice(0, 8)}</span>
          <button className="button button-secondary" onClick={() => void syncNow()} type="button">
            {isSyncing ? "Syncing..." : "Sync now"}
          </button>
          <button className="button button-ghost" onClick={signOut} type="button">
            Sign out
          </button>
        </div>
      </header>

      <section className="metric-grid">
        <article className="metric-card">
          <p>Pending</p>
          <strong>{stats.pending}</strong>
        </article>
        <article className="metric-card">
          <p>Synced</p>
          <strong>{stats.synced}</strong>
        </article>
        <article className="metric-card">
          <p>Failed</p>
          <strong>{stats.failed}</strong>
        </article>
        <article className="metric-card">
          <p>Media files</p>
          <strong>{stats.mediaCount}</strong>
        </article>
      </section>

      <section className="split-grid">
        <section className="panel">
          <div className="section-header">
            <div>
              <span className="eyebrow">New evidence</span>
              <h2>Create field record</h2>
              <p>Every submission gets a timestamp, device ID, user ID, project ID, and GPS only at the moment of submission.</p>
            </div>
          </div>

          <form className="form-grid" onSubmit={handleSubmit}>
            <div className="two-up">
              <div className="input-group">
                <label htmlFor="projectId">Project ID</label>
                <input className="input" id="projectId" onChange={(event) => setProjectId(event.target.value)} required value={projectId} />
              </div>
              <div className="input-group">
                <label htmlFor="projectName">Project</label>
                <input className="input" id="projectName" onChange={(event) => setProjectName(event.target.value)} required value={projectName} />
              </div>
            </div>

            <div className="two-up">
              <div className="input-group">
                <label htmlFor="milestoneId">Milestone ID</label>
                <input className="input" id="milestoneId" onChange={(event) => setMilestoneId(event.target.value)} value={milestoneId} />
              </div>
              <div className="input-group">
                <label htmlFor="beneficiaryName">Beneficiary</label>
                <input
                  className="input"
                  id="beneficiaryName"
                  onChange={(event) => setBeneficiaryName(event.target.value)}
                  required
                  value={beneficiaryName}
                />
              </div>
            </div>

            <div className="input-group">
              <label htmlFor="interactionType">Beneficiary interaction</label>
              <select className="select" id="interactionType" onChange={(event) => setInteractionType(event.target.value as LocalRecordWithMedia["interactionType"])} value={interactionType}>
                <option value="visit">Visit</option>
                <option value="distribution">Distribution</option>
                <option value="training">Training</option>
                <option value="verification">Verification</option>
              </select>
            </div>

            <div className="input-group">
              <label htmlFor="notes">Interaction notes</label>
              <textarea className="textarea" id="notes" onChange={(event) => setNotes(event.target.value)} required value={notes} />
            </div>

            <div className="input-group">
              <label htmlFor="media">Photo or video evidence</label>
              <input
                accept="image/*,video/*"
                capture="environment"
                className="file-input"
                id="media"
                multiple
                onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
                type="file"
              />
              <p className="subtle">Selected {files.length} file(s) • {formatBytes(queuedBytes)}</p>
            </div>

            <div className="check-row">
              <input checked={captureGps} id="captureGps" onChange={(event) => setCaptureGps(event.target.checked)} type="checkbox" />
              <label htmlFor="captureGps">Capture GPS coordinates only when submitting this record</label>
            </div>

            {submitState ? <div className="info-banner">{submitState}</div> : null}

            <div className="auth-actions">
              <button className="button button-primary" disabled={submitting} type="submit">
                {submitting ? "Saving..." : "Save local record"}
              </button>
              <button className="button button-secondary" onClick={() => void syncNow()} type="button">
                Trigger sync
              </button>
            </div>
          </form>
        </section>

        <section className="panel">
          <div className="section-header">
            <div>
              <span className="eyebrow">Workflow notes</span>
              <h2>What happens on submit</h2>
            </div>
          </div>
          <ol className="helper-list">
            <li>The form saves into IndexedDB, even with no network.</li>
            <li>Each record stores media, GPS, timestamp, device ID, user ID, and project ID locally.</li>
            <li>Each attached file is stored as a blob in the local media table.</li>
            <li>A queue item is created with attempt count and next retry timestamp.</li>
            <li>The sync worker uploads in batches, retries failures, and deduplicates by client UUID.</li>
            <li>The manager workspace reads immutable synced evidence records with receipt metadata.</li>
          </ol>
          <div className="footer-note">Open this on Android Chrome, install it, then test in airplane mode.</div>
        </section>
      </section>

      <section className="panel">
        <div className="section-header">
          <div>
            <span className="eyebrow">Recent submissions</span>
            <h2>Device evidence log</h2>
            <p>Pending items stay editable in local storage until the sync worker confirms them.</p>
          </div>
        </div>

        {records.length === 0 ? (
          <div className="empty-state">
            <h3>No submissions yet</h3>
            <p>Create the first field record to test offline queueing.</p>
          </div>
        ) : (
          <div className="list-stack">
            {records.map((record) => (
              <article className="list-card" key={record.id}>
                <div className="record-topline">
                  <h3 className="record-title">{record.projectName}</h3>
                  <StatusPill status={record.status} />
                </div>
                <div className="record-meta subtle">
                  <span>Project ID: {record.projectId}</span>
                  <span>Beneficiary: {record.beneficiaryName}</span>
                  <span>Interaction: {record.interactionType}</span>
                  <span>Submitted: {new Date(record.submittedAtDevice).toLocaleString()}</span>
                  <span>By: {record.userName}</span>
                </div>
                <p>{record.notes}</p>
                <div className="timeline-row mono">
                  <span>UUID {record.id.slice(0, 8)}</span>
                  <span>Device {record.deviceId.slice(0, 8)}</span>
                  <span>Milestone {record.milestoneId ?? "unassigned"}</span>
                  <span>
                    GPS {record.gpsLat ? `${record.gpsLat.toFixed(5)}, ${record.gpsLng?.toFixed(5)}` : "not captured"}
                  </span>
                  {record.lastError ? <span>Error: {record.lastError}</span> : null}
                </div>
                {record.media.length > 0 ? (
                  <div className="media-grid">
                    {record.media.map((media) => (
                      <MediaPreview blob={media.blob} key={media.id} label={`${media.fileName} • ${formatBytes(media.size)}`} mimeType={media.mimeType} />
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
