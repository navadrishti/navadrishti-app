"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useAppContext } from "@/components/app-provider";
import { MediaPreview } from "@/components/media-preview";
import { db } from "@/lib/db";

export function ManagerConsole() {
  const { ready, session, isOnline, signOut, syncNow, isSyncing } = useAppContext();

  const remoteRecords = useLiveQuery(() => db.remoteRecords.orderBy("syncedAt").reverse().toArray(), [], []);
  const syncLog = useLiveQuery(() => db.syncLog.orderBy("createdAt").reverse().limit(6).toArray(), [], []);
  const auditReady = remoteRecords.filter((record) => record.auditStatus === "ready").length;
  const milestoneAttached = remoteRecords.filter((record) => Boolean(record.milestoneId)).length;

  if (!ready) {
    return <main className="shell"><section className="panel">Loading manager workspace...</section></main>;
  }

  if (!session || session.role !== "manager") {
    return (
      <main className="shell">
        <section className="panel">
          <span className="eyebrow">Restricted</span>
          <h2>Manager access requires a manager session.</h2>
          <p className="subtle">Sign in from the home page as a manager to review synced evidence.</p>
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
    <main className="shell manager-layout">
      <header className="site-header">
        <Link className="brand" href="/">
          <img className="brand-mark" src="/logo.svg" alt="Navadrishti logo" />
          <span>Manager dashboard</span>
        </Link>
        <div className="nav-row">
          <span className={`status-chip ${isOnline ? "online" : "offline"}`}>{isOnline ? "Online" : "Offline"}</span>
          <button className="button button-secondary" onClick={() => void syncNow()} type="button">
            {isSyncing ? "Syncing..." : "Refresh from queue"}
          </button>
          <button className="button button-ghost" onClick={signOut} type="button">
            Sign out
          </button>
        </div>
      </header>

      <section className="sub-grid">
        <article className="panel">
          <div className="section-header">
            <div>
              <span className="eyebrow">Remote mirror</span>
              <h2>Submitted evidence</h2>
              <p>
                This dashboard is backed by a demo remote table that represents the immutable payload your backend would store
                after sync confirmation.
              </p>
            </div>
          </div>
          <div className="metric-grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <article className="metric-card">
              <p>Synced records</p>
              <strong>{remoteRecords.length}</strong>
            </article>
            <article className="metric-card">
              <p>Latest sync</p>
              <strong>{remoteRecords[0] ? new Date(remoteRecords[0].syncedAt).toLocaleDateString() : "none"}</strong>
            </article>
            <article className="metric-card">
              <p>Audit-ready</p>
              <strong>{auditReady}</strong>
            </article>
            <article className="metric-card">
              <p>Attached to milestones</p>
              <strong>{milestoneAttached}</strong>
            </article>
          </div>
        </article>

        <article className="panel">
          <div className="section-header">
            <div>
              <span className="eyebrow">Queue log</span>
              <h2>Recent sync activity</h2>
            </div>
          </div>
          {syncLog.length === 0 ? (
            <div className="empty-state">
              <p>No sync activity recorded yet.</p>
            </div>
          ) : (
            <div className="list-stack">
              {syncLog.map((entry) => (
                <article className="list-card" key={entry.id}>
                  <div className="record-topline">
                    <span className={`pill ${entry.level === "error" ? "failed" : "synced"}`}>{entry.level}</span>
                    <span className="mono">{new Date(entry.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <p>{entry.message}</p>
                  <div className="mono subtle">Record {entry.recordId.slice(0, 8)}</div>
                </article>
              ))}
            </div>
          )}
        </article>
      </section>

      <section className="panel">
        <div className="section-header">
          <div>
            <span className="eyebrow">Evidence feed</span>
              <h2>Company and audit review</h2>
              <p>These records are immutable after receipt confirmation and can be attached to milestones or audits.</p>
          </div>
        </div>
        {remoteRecords.length === 0 ? (
          <div className="empty-state">
            <h3>No synced records yet</h3>
            <p>Create a field record and bring the device online to move it here.</p>
          </div>
        ) : (
          <div className="list-stack">
            {remoteRecords.map((record) => (
              <article className="list-card" key={record.id}>
                <div className="record-topline">
                  <h3 className="record-title">{record.projectName}</h3>
                  <span className="pill synced">synced</span>
                  <span className="pill syncing">immutable</span>
                </div>
                <div className="record-meta subtle">
                  <span>Project ID: {record.projectId}</span>
                  <span>Beneficiary: {record.beneficiaryName}</span>
                  <span>Interaction: {record.interactionType}</span>
                  <span>Captured by: {record.userName}</span>
                  <span>Synced: {new Date(record.syncedAt).toLocaleString()}</span>
                </div>
                <p>{record.notes}</p>
                <div className="timeline-row mono">
                  <span>Client UUID {record.sourceRecordId.slice(0, 8)}</span>
                  <span>Receipt {record.receiptId.slice(0, 13)}</span>
                  <span>Device {record.deviceId.slice(0, 8)}</span>
                  <span>Milestone {record.milestoneId ?? "unassigned"}</span>
                  <span>Audit {record.auditStatus}</span>
                  <span>
                    GPS {record.gpsLat ? `${record.gpsLat.toFixed(5)}, ${record.gpsLng?.toFixed(5)}` : "not captured"}
                  </span>
                </div>
                {record.media.length > 0 ? (
                  <div className="media-grid">
                    {record.media.map((media) => (
                      <MediaPreview blob={media.blob} key={media.id} label={media.fileName} mimeType={media.mimeType} />
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
