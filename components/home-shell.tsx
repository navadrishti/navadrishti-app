"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { useAppContext } from "@/components/app-provider";
import type { SessionRole } from "@/lib/types";

export function HomeShell() {
  const { ready, session, isOnline, signIn, signOut, isSyncing, lastSync } = useAppContext();
  const [role, setRole] = useState<SessionRole>("field");
  const [name, setName] = useState("Asha Field Officer");
  const [email, setEmail] = useState("field@navadrishti.demo");
  const [password, setPassword] = useState("offline123");
  const [error, setError] = useState<string | null>(null);

  const destination = useMemo(() => {
    if (!session) {
      return role === "field" ? "/field" : "/manager";
    }

    return session.role === "field" ? "/field" : "/manager";
  }, [role, session]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    try {
      await signIn({ name, email, password, role });
      window.location.href = role === "field" ? "/field" : "/manager";
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to sign in.");
    }
  }

  return (
    <main className="shell">
      <header className="site-header">
        <Link className="brand" href="/">
          <img className="brand-mark" src="/logo.svg" alt="Navadrishti logo" />
          <span>
            Navadrishti <span className="subtle">Field App MVP</span>
          </span>
        </Link>
        <div className={`status-chip ${isOnline ? "online" : "offline"}`}>
          {isOnline ? "Online" : "Offline"}
          {isSyncing ? " • syncing" : ""}
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Phase 1 delivery</span>
          <h1>Capture field evidence once, trust it later.</h1>
          <p>
            This starter ships the core loop you asked for: field login, an offline submission form, photo or
            video capture, GPS only at submit time, device and user stamping, a retrying sync queue, and immutable
            evidence review for milestone and audit use.
          </p>
          <div className="cta-row">
            <Link className="button button-primary" href={destination}>
              {session ? "Continue to workspace" : "Open the MVP"}
            </Link>
            <a className="button button-secondary" href="#scope">
              See what is included
            </a>
          </div>
        </div>

        <div className="hero-notes">
          <article className="note-card">
            <strong>Offline-first</strong>
            <span>Records, media blobs, queue state, and sync logs live in IndexedDB.</span>
          </article>
          <article className="note-card">
            <strong>Submission-only GPS</strong>
            <span>The app captures location only when a record is submitted, not continuously.</span>
          </article>
          <article className="note-card">
            <strong>Installable PWA</strong>
            <span>Manifest and service worker config are in place for install prompts and offline fallback.</span>
          </article>
          <article className="note-card">
            <strong>Backend-ready seams</strong>
            <span>The sync layer is isolated so Supabase and Cloudinary can replace the local demo remote store.</span>
          </article>
        </div>
      </section>

      <section className="split-grid" style={{ marginTop: 20 }}>
        <div className="panel auth-panel">
          <div className="section-header">
            <div>
              <span className="eyebrow">Access</span>
              <h2>{session ? "Session active" : "Local sign-in"}</h2>
              <p>
                This MVP uses a local auth adapter so you can test immediately. Replace it with Supabase auth once
                your project keys are ready.
              </p>
            </div>
          </div>

          {session ? (
            <>
              <div className="info-banner">
                Signed in as <strong>{session.name}</strong> ({session.role}) using <span className="mono">{session.email}</span>
              </div>
              <div className="auth-actions">
                <Link className="button button-primary" href={session.role === "field" ? "/field" : "/manager"}>
                  Continue
                </Link>
                <button className="button button-secondary" onClick={signOut} type="button">
                  Sign out
                </button>
              </div>
              {lastSync ? (
                <p className="subtle">
                  Last sync checked {lastSync.processed} queued item(s) and completed {lastSync.succeeded}.
                </p>
              ) : null}
            </>
          ) : (
            <form className="form-grid" onSubmit={handleSubmit}>
              <div className="input-group">
                <label htmlFor="role">Workspace</label>
                <select className="select" id="role" onChange={(event) => setRole(event.target.value as SessionRole)} value={role}>
                  <option value="field">Field user</option>
                  <option value="manager">Manager</option>
                </select>
              </div>
              <div className="two-up">
                <div className="input-group">
                  <label htmlFor="name">Name</label>
                  <input className="input" id="name" onChange={(event) => setName(event.target.value)} value={name} />
                </div>
                <div className="input-group">
                  <label htmlFor="email">Email</label>
                  <input className="input" id="email" onChange={(event) => setEmail(event.target.value)} value={email} />
                </div>
              </div>
              <div className="input-group">
                <label htmlFor="password">Password</label>
                <input
                  className="input"
                  id="password"
                  minLength={6}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  value={password}
                />
              </div>
              {error ? <div className="info-banner">{error}</div> : null}
              <div className="auth-actions">
                <button className="button button-primary" type="submit">
                  Enter {role === "field" ? "field" : "manager"} workspace
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="panel" id="scope">
          <div className="section-header">
            <div>
              <span className="eyebrow">Included today</span>
              <h2>MVP scope</h2>
            </div>
          </div>
          <ol className="helper-list">
            <li>Field login and role-aware workspace routing.</li>
            <li>Project ID, project name, beneficiary interaction, GPS, timestamp, device ID, user ID, and media capture.</li>
            <li>IndexedDB storage for local records, media blobs, queue items, and sync logs.</li>
            <li>Retrying batch sync worker with exponential backoff when the browser comes back online.</li>
            <li>UUID dedupe and confirmed receipt semantics in the sync layer.</li>
            <li>Manager dashboard fed from a demo remote store that mirrors immutable audit-ready server records.</li>
            <li>PWA manifest and service worker wiring for installability and offline fallback.</li>
          </ol>
          <div className="footer-note">
            {ready ? "The app is ready to test in airplane mode." : "Preparing client state..."}
          </div>
        </div>
      </section>
    </main>
  );
}
