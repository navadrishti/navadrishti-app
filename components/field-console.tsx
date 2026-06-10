"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useAppContext } from "@/components/app-provider";
import { calculateHash } from "@/lib/crypto";
import { db } from "@/lib/db";
import { getDeviceId } from "@/lib/device";
import { getCurrentPosition } from "../lib/utils";
import type { LocalMediaRecord, LocalRecord, LocalRecordWithMedia, ReferencePoint, AwcSite, LocalMilestone } from "@/lib/types";

if (typeof window !== "undefined") {
  (window as any).db = db;
}

/**
 * Haversine formula — returns distance in metres between two GPS coordinates.
 */
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => deg * (Math.PI / 180);
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function FieldConsole() {
  const { session, sessionLoading, isOnline, isSyncing, signOut, syncNow } = useAppContext();
  const [capturedBlobs, setCapturedBlobs] = useState<{ blob: Blob; url: string; name: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitState, setSubmitState] = useState<string | null>(null);
  const [deviceId] = useState(() => getDeviceId());
  const [activePreviewUrl, setActivePreviewUrl] = useState<string | null>(null);

  // Camera State
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);

  const isGovUser = session?.role === "gov";

  // Shared Queries (Isolated by Logged-in User)
  const records = useLiveQuery(async () => {
    if (!session?.id) return [];
    const local = await db.recordsLocal
      .where("userId")
      .equals(session.id)
      .reverse()
      .toArray();
    const media = await db.mediaLocal.toArray();
    return local.map(r => ({ ...r, media: media.filter(m => m.recordId === r.id) }));
  }, [session?.id], []);

  const stats = useLiveQuery(async () => {
    if (!session?.id) return { pending: 0, synced: 0, mediaCount: 0 };
    const all = await db.recordsLocal.where("userId").equals(session.id).toArray();
    const mediaCount = await db.mediaLocal.count(); // Count of all local media
    return {
      pending: all.filter(r => r.status === "pending" || r.status === "syncing").length,
      synced: all.filter(r => r.status === "synced").length,
      mediaCount
    };
  }, [session?.id], { pending: 0, synced: 0, mediaCount: 0 });

  // Camera Controls
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraReady(false);
  }, []);

  const startCamera = async () => {
    setCameraLoading(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
        setCameraReady(true);
      }
    } catch (err) {
      console.error("Camera error:", err);
    } finally {
      setCameraLoading(false);
    }
  };

  const capturePhoto = async (contextLabel: string) => {
    if (!videoRef.current || !canvasRef.current || !cameraReady) return;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    context.drawImage(videoRef.current, 0, 0);
    context.font = "24px monospace"; context.fillStyle = "yellow";
    context.fillText(new Date().toLocaleString(), 20, canvas.height - 40);
    context.fillText(contextLabel.slice(0, 30), 20, canvas.height - 70);
    canvas.toBlob(blob => {
      if (blob) setCapturedBlobs(p => [...p, { blob, url: URL.createObjectURL(blob), name: `cap-${Date.now()}.jpg` }]);
    }, "image/jpeg", 0.9);
  };

  useEffect(() => { return () => stopCamera(); }, [stopCamera]);

  // Main Submit Logic
  async function handleSeal(data: {
    beneficiaryName: string | null;
    interactionType: string;
    notes: string;
    projectId: string | null;
    projectName: string;
    milestoneId: string | null;
    siteId: string | null;
    siteName: string | null;
    referencePointId: string | null;
    refPoint?: ReferencePoint;
  }) {
    if (!session) return;
    setSubmitting(true);
    setSubmitState(null);

    try {
      // 1. FRESH GPS POLL
      const coords = await getCurrentPosition();
      if (!coords) throw new Error("Could not acquire GPS signal. Check permissions.");

      // 2. GEO VALIDATION (FOR GOV)
      let geoDistance: number | null = null;
      let geoValidated = true;

      if (isGovUser && data.refPoint) {
        geoDistance = haversineDistance(coords.latitude, coords.longitude, data.refPoint.latitude, data.refPoint.longitude);
        geoValidated = geoDistance <= (data.refPoint.radius ?? 100);
        
        if (!geoValidated) {
          throw new Error(`Location Verification Failed: You are ${(geoDistance - (data.refPoint.radius ?? 100)).toFixed(0)}m outside the required radius.`);
        }
      }

      const recordId = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      // 3. MEDIA PREP
      const mediaEntries: LocalMediaRecord[] = await Promise.all(
        capturedBlobs.map(async (item) => ({
          id: crypto.randomUUID(), recordId, fileName: item.name, mimeType: item.blob.type, size: item.blob.size, kind: "image" as const, blob: item.blob, proofHash: await calculateHash(item.blob), createdAt
        }))
      );

      // 4. RECORD ASSEMBLY
      const record: LocalRecord = {
        id: recordId, deviceId, userId: session.id, userName: session.name,
        projectId: data.projectId, projectName: data.projectName, milestoneId: data.milestoneId,
        siteId: data.siteId, siteName: data.siteName, referencePointId: data.referencePointId,
        userType: isGovUser ? "gov" : "ngo",
        geoDistance, geoValidated,
        beneficiaryName: data.beneficiaryName,
        interactionType: data.interactionType as any,
        notes: data.notes,
        gpsLat: coords.latitude, gpsLng: coords.longitude,
        status: "pending", createdAtDevice: createdAt, submittedAtDevice: createdAt, syncedAt: null, lastError: null
      };

      await db.transaction("rw", [db.recordsLocal, db.mediaLocal, db.syncQueue, db.milestones], async () => {
        await db.recordsLocal.add(record);
        await db.mediaLocal.bulkAdd(mediaEntries);
        await db.syncQueue.put({ id: recordId, recordId, status: "pending", attempts: 0, nextAttemptAt: Date.now(), lastError: null, createdAt, updatedAt: createdAt });
        if (data.milestoneId) await db.milestones.update(data.milestoneId, { status: "submitted", updatedAt: createdAt });
      });

      setCapturedBlobs([]); setSubmitState("Evidence sealed and queued for sync.");
      if (isOnline) await syncNow();
    } catch (error) {
      setSubmitState(error instanceof Error ? error.message : "Submission failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sessionLoading) return <main className="app"><section className="card-section">Initialising Terminal...</section></main>;

  return (
    <main className="app">
      <header className="app-header">
        <div className="header-left">
          <img className="header-logo" src="/logo.svg" alt="ND" />
          <div>
            <h1 className="header-org">{session?.ngoName || "Field Operator"}</h1>
            <p className="header-meta">{session?.role?.toUpperCase()} • {isOnline ? "Connected" : "Offline"}</p>
          </div>
        </div>
        <button className="btn-outline" onClick={signOut}>Exit</button>
      </header>

      {/* Dashboard Metrics */}
      <section className="card-section">
        <div className="chips-row">
          <div className="chip">
             <div className={`chip-dot ${isSyncing ? 'dot-syncing' : (isOnline ? 'dot-online' : 'dot-offline')}`} />
             {isSyncing ? "Syncing..." : (isOnline ? "Server Live" : "Local Only")}
          </div>
          <div className="chip"><span className="badge badge-slate">Queue</span> {stats.pending}</div>
          <div className="chip"><span className="badge badge-blue">Media</span> {stats.mediaCount}</div>
        </div>
      </section>

      {isGovUser ? (
        <GovCaptureView 
          onSeal={handleSeal} 
          submitting={submitting} 
          submitState={submitState}
          capturedBlobs={capturedBlobs}
          setCapturedBlobs={setCapturedBlobs}
          cameraReady={cameraReady}
          cameraLoading={cameraLoading}
          startCamera={startCamera}
          stopCamera={stopCamera}
          capturePhoto={capturePhoto}
          videoRef={videoRef}
          canvasRef={canvasRef}
          onPreviewImage={setActivePreviewUrl}
        />
      ) : (
        <NgoCaptureView 
          onSeal={handleSeal} 
          submitting={submitting} 
          submitState={submitState}
          capturedBlobs={capturedBlobs}
          setCapturedBlobs={setCapturedBlobs}
          cameraReady={cameraReady}
          cameraLoading={cameraLoading}
          startCamera={startCamera}
          stopCamera={stopCamera}
          capturePhoto={capturePhoto}
          videoRef={videoRef}
          canvasRef={canvasRef}
          onPreviewImage={setActivePreviewUrl}
        />
      )}

      {/* Shared Ledger */}
      <section className="card-section">
        <span className="section-title">Recent Device History</span>
        <div style={{ display: 'grid', gap: '8px' }}>
          {records.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>No local records found.</p>}
          {records.slice(0, 5).map(r => (
            <div key={r.id} className="ledger-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div className="ledger-info">
                  <div className="ledger-title">{r.siteName || r.beneficiaryName || "Evidence Record"}</div>
                  <div className="ledger-meta">{r.projectName} • {new Date(r.submittedAtDevice).toLocaleTimeString()}</div>
                </div>
                <div className={`status-badge status-${r.status}`}>{r.status}</div>
              </div>
              <LedgerItemMedia media={r.media} onPreview={setActivePreviewUrl} />
            </div>
          ))}
        </div>
      </section>

      {/* Full-Size Lightbox Preview Modal */}
      {activePreviewUrl && (
        <div 
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            backdropFilter: 'blur(8px)',
            cursor: 'zoom-out'
          }} 
          onClick={() => setActivePreviewUrl(null)}
        >
          <div style={{ position: 'relative', maxWidth: '90%', maxHeight: '90%' }} onClick={e => e.stopPropagation()}>
            <img 
              src={activePreviewUrl} 
              style={{ maxWidth: '100%', maxHeight: '80vh', objectFit: 'contain', borderRadius: 'var(--radius-md)', border: '2px solid rgba(255,255,255,0.2)' }} 
              alt="Full Preview" 
            />
            <button 
              onClick={() => setActivePreviewUrl(null)} 
              style={{
                position: 'absolute',
                top: '-45px',
                right: '0',
                background: '#fff',
                color: '#000',
                fontWeight: 'bold',
                fontSize: '0.8rem',
                padding: '6px 14px',
                borderRadius: '8px',
                border: 'none',
                cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function NgoCaptureView(props: any) {
  const [beneficiaryName, setBeneficiaryName] = useState("");
  const [notes, setNotes] = useState("");
  const [interactionType, setInteractionType] = useState("visit");

  const milestones = useLiveQuery(() => db.milestones.orderBy("milestoneOrder").toArray(), [], []);
  const activeMilestone = useMemo(() => {
    if (!milestones || milestones.length === 0) return null;
    return milestones.find(m => m.status !== "paid") || milestones[0];
  }, [milestones]);

  if (!activeMilestone) return <section className="card-section">No CSR assignments found.</section>;

  const isLocked = activeMilestone.status !== "pending";

  return (
    <>
      <section className="card-section">
        <span className="section-title">CSR Milestone</span>
        <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>{activeMilestone.title}</div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{activeMilestone.description}</p>
      </section>

      <CameraCard {...props} contextLabel={activeMilestone.title} />

      <section className="card-section">
        <span className="section-title">Record Details</span>
        <form onSubmit={e => { e.preventDefault(); props.onSeal({ beneficiaryName, interactionType, notes, projectId: activeMilestone.projectId, projectName: activeMilestone.title, milestoneId: activeMilestone.id, siteId: null, siteName: null, referencePointId: null }); }}>
          <fieldset disabled={isLocked || props.submitting} style={{ border: 'none' }}>
            <div className="form-group">
              <label>Beneficiary Name</label>
              <input value={beneficiaryName} onChange={e => setBeneficiaryName(e.target.value)} required placeholder="Full legal name" />
            </div>
            <div className="form-group">
              <label>Interaction</label>
              <select value={interactionType} onChange={e => setInteractionType(e.target.value)}>
                <option value="visit">Field Visit</option>
                <option value="distribution">Distribution</option>
              </select>
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} required rows={3} />
            </div>
          </fieldset>
          {props.submitState && <div className="form-error" style={{ background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' }}>{props.submitState}</div>}
          {!isLocked && <button type="submit" className="btn-primary" disabled={props.submitting || props.capturedBlobs.length === 0}>Seal & Sync</button>}
        </form>
      </section>
    </>
  );
}

function GovCaptureView(props: any) {
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [selectedRefPointId, setSelectedRefPointId] = useState("");
  const [notes, setNotes] = useState("");

  const sites = useLiveQuery(() => db.awcSites.toArray(), [], []);
  const refPoints = useLiveQuery(async () => {
    if (!selectedSiteId) return [];
    return db.referencePoints.where("siteId").equals(selectedSiteId).toArray();
  }, [selectedSiteId], []);

  const selectedSite = useMemo(() => sites?.find(s => s.id === selectedSiteId), [sites, selectedSiteId]);
  const selectedRefPoint = useMemo(() => refPoints?.find(r => r.id === selectedRefPointId), [refPoints, selectedRefPointId]);

  if (sites?.length === 0) return <section className="card-section">No AWC Infrastructure sites assigned.</section>;

  return (
    <>
      <section className="card-section">
        <span className="section-title">Site Verification</span>
        <div className="form-group">
          <label>AWC Site</label>
          <select value={selectedSiteId} onChange={e => { setSelectedSiteId(e.target.value); setSelectedRefPointId(""); }}>
            <option value="">Select site...</option>
            {sites?.map(s => <option key={s.id} value={s.id}>{s.name} ({s.district})</option>)}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Verification Asset</label>
          <select value={selectedRefPointId} onChange={e => setSelectedRefPointId(e.target.value)} disabled={!selectedSiteId}>
            <option value="">{selectedSiteId ? "Select asset..." : "Select site first"}</option>
            {refPoints?.map(rp => <option key={rp.id} value={rp.id}>{rp.name}</option>)}
          </select>
          {selectedSiteId && refPoints?.length === 0 && <p style={{ color: 'var(--error)', fontSize: '0.7rem', marginTop: '4px' }}>No assets found for this site.</p>}
        </div>
      </section>

      <CameraCard {...props} contextLabel={selectedRefPoint?.name || "Infrastructure"} referenceImageUrl={selectedRefPoint?.imageUrl} disabled={!selectedRefPointId} />

      <section className="card-section">
        <span className="section-title">Audit Log</span>
        <form onSubmit={e => { e.preventDefault(); props.onSeal({ beneficiaryName: null, interactionType: "verification", notes, projectId: null, projectName: selectedSite?.name || "AWC", milestoneId: null, siteId: selectedSiteId, siteName: selectedSite?.name, referencePointId: selectedRefPointId, refPoint: selectedRefPoint }); }}>
          <fieldset disabled={props.submitting || !selectedRefPointId} style={{ border: 'none' }}>
            <div className="form-group">
              <label>Field Observations</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} required rows={3} placeholder="Describe the physical condition..." />
            </div>
          </fieldset>
          {props.submitState && <div className="form-error">{props.submitState}</div>}
          <button type="submit" className="btn-primary" disabled={props.submitting || props.capturedBlobs.length === 0 || !selectedRefPointId}>
            {props.submitting ? "Verifying GPS..." : "Seal Infrastructure Audit"}
          </button>
        </form>
      </section>
    </>
  );
}

function CameraCard(props: any) {
  const hasRefImage = !!props.referenceImageUrl;

  return (
    <section className="card-section" style={{ opacity: props.disabled ? 0.5 : 1, pointerEvents: props.disabled ? 'none' : 'auto' }}>
      <span className="section-title">Evidence Capture</span>
      
      {hasRefImage ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
          {/* Reference Image Panel */}
          <div style={{ position: 'relative', width: '100%', aspectRatio: '4/3', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1.5px solid var(--line)', background: '#1e293b' }}>
            <img 
              src={props.referenceImageUrl} 
              style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer' }} 
              alt="Reference Standard" 
              onClick={() => props.onPreviewImage(props.referenceImageUrl)}
            />
            <div style={{ position: 'absolute', bottom: '6px', left: '6px', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '0.65rem', padding: '3px 8px', borderRadius: '4px', fontWeight: 600 }}>
              Reference Photo
            </div>
          </div>

          {/* Active Viewfinder Panel */}
          <div className="viewfinder" style={{ marginBottom: 0 }}>
            <video ref={props.videoRef} autoPlay playsInline muted />
            {!props.cameraReady && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: '#000', color: '#fff', fontSize: '0.65rem' }}>{props.cameraLoading ? "Hardware Initialising..." : "Viewfinder Offline"}</div>}
            <div className="viewfinder-overlay">
              <div className="viewfinder-corner top-l" />
              <div className="viewfinder-corner top-r" />
              <div className="viewfinder-corner bot-l" />
              <div className="viewfinder-corner bot-r" />
            </div>
            <canvas ref={props.canvasRef} hidden />
          </div>
        </div>
      ) : (
        <div className="viewfinder">
          <video ref={props.videoRef} autoPlay playsInline muted />
          {!props.cameraReady && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: '#000', color: '#fff', fontSize: '0.75rem' }}>{props.cameraLoading ? "Hardware Initialising..." : "Viewfinder Offline"}</div>}
          <div className="viewfinder-overlay">
            <div className="viewfinder-corner top-l" />
            <div className="viewfinder-corner top-r" />
            <div className="viewfinder-corner bot-l" />
            <div className="viewfinder-corner bot-r" />
          </div>
          <canvas ref={props.canvasRef} hidden />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
         <button className="btn-outline" onClick={props.cameraReady ? props.stopCamera : props.startCamera} style={{ flex: 1 }}>{props.cameraReady ? "Stop Feed" : "Open Camera"}</button>
         <button className="btn-shutter" onClick={() => props.capturePhoto(props.contextLabel)} disabled={!props.cameraReady || props.capturedBlobs.length >= 5}><div className="btn-shutter-inner" /></button>
         <div style={{ flex: 1, textAlign: 'right', fontWeight: 800, fontSize: '1.5rem' }}>{props.capturedBlobs.length}<span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>/5</span></div>
      </div>
      <div className="chips-row" style={{ marginTop: '20px' }}>
        {props.capturedBlobs.map((item: any, idx: number) => (
          <div key={idx} style={{ position: 'relative' }}>
            <img 
              src={item.url} 
              style={{ width: '50px', height: '50px', borderRadius: '10px', objectFit: 'cover', cursor: 'pointer' }} 
              alt="cap" 
              onClick={() => props.onPreviewImage(item.url)}
            />
            <button onClick={() => props.setCapturedBlobs((p: any) => p.filter((_: any, i: any) => i !== idx))} style={{ position: 'absolute', top: -5, right: -5, background: 'var(--error)', color: '#fff', borderRadius: '50%', width: '18px', height: '18px', fontSize: '10px', border: '2px solid #fff' }}>×</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function LedgerItemMedia({ media, onPreview }: { media: LocalMediaRecord[], onPreview: (url: string) => void }) {
  const urls = useMemo(() => {
    return media.map(m => URL.createObjectURL(m.blob));
  }, [media]);

  useEffect(() => {
    return () => {
      urls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [urls]);

  if (media.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
      {media.map((item, idx) => (
        <img
          key={item.id}
          src={urls[idx]}
          className="ledger-thumb"
          style={{ cursor: 'pointer', border: '1.5px solid var(--line)' }}
          alt={item.fileName}
          onClick={() => onPreview(urls[idx])}
        />
      ))}
    </div>
  );
}
