"use client";

import { useAppContext } from "@/components/app-provider";
import { FieldConsole } from "@/components/field-console";
import { FieldOfficerEvidence } from "@/components/field-officer-evidence";
import { AppFooter, ProductBrand } from "@/components/product-brand";
import { LoginBootstrapSkeleton } from "@/components/skeleton";
import { apiFetch } from "@/lib/env";
import { getDeviceId } from "@/lib/utils";
import type { AppSession } from "@/lib/types";
import { useState } from "react";

function FieldOfficerPasswordChange({
  onComplete,
  onSignOut,
}: {
  onComplete: (session: AppSession) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to update password.");
      if (data.session) {
        await onComplete(data.session as AppSession);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <div className="login-shell">
        <ProductBrand
          size="md"
          nameClassName="brand-name-on-field"
          poweredClassName="brand-powered-on-field"
        />
        <section className="login-card">
          <div className="login-brand">
            <h1>Change password</h1>
            <p className="login-status">You must set a new password before continuing.</p>
          </div>
          <form className="login-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="current-password">Current password</label>
              <input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            <div className="form-group">
              <label htmlFor="new-password">New password</label>
              <input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>
            <div className="form-group">
              <label htmlFor="confirm-password">Confirm new password</label>
              <input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>
            {error && <div className="form-error">{error}</div>}
            <button type="submit" disabled={loading}>
              {loading ? "Updating…" : "Update password"}
            </button>
          </form>
          <div style={{ marginTop: "16px" }}>
            <button type="button" className="btn-secondary" style={{ width: "100%" }} onClick={onSignOut}>
              Sign Out
            </button>
          </div>
        </section>
        <AppFooter />
      </div>
    </main>
  );
}

function FieldOfficerHome({ session, onSignOut }: { session: AppSession; onSignOut: () => Promise<void> }) {
  return (
    <main className="login-screen">
      <div className="login-shell">
        <ProductBrand
          size="md"
          nameClassName="brand-name-on-field"
          poweredClassName="brand-powered-on-field"
        />
        <section className="login-card">
          <div className="login-brand">
            <h1>Field Officer</h1>
            <p className="login-status">Signed in as {session.name}.</p>
          </div>

          <p className="login-status" style={{ marginTop: 16 }}>
            Submit milestone evidence for projects your NGO administrator assigned to you. You can
            sign in from any compatible device. Attendance is not part of the Field Officer role.
            Offline captures stay on this device until they sync while the app is open.
          </p>

          <FieldOfficerEvidence session={session} />

          <div style={{ display: "grid", gap: 12, marginTop: 20 }}>
            <button type="button" className="btn-secondary" onClick={onSignOut}>
              Sign Out
            </button>
          </div>
        </section>
        <AppFooter />
      </div>
    </main>
  );
}

export default function HomePage() {
  const { session, sessionLoading, applySession, signOut } = useAppContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, device_id: getDeviceId() }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");

      if (data.session) {
        await applySession(data.session as AppSession);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid credentials");
    } finally {
      setLoading(false);
    }
  }

  if (sessionLoading) {
    return <LoginBootstrapSkeleton />;
  }

  if (!session) {
    return (
      <main className="login-screen">
        <div className="login-shell">
          <ProductBrand
            size="md"
            nameClassName="brand-name-on-field"
            poweredClassName="brand-powered-on-field"
          />

          <section className="login-card">
            <form className="login-form" onSubmit={handleLogin}>
              <div className="form-group">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                />
              </div>

              <div className="form-group">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>

              {error && <div className="form-error">{error}</div>}

              <button type="submit" disabled={loading}>
                {loading ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Signing in…
                  </>
                ) : (
                  "Sign In"
                )}
              </button>
            </form>
          </section>

          <AppFooter />
        </div>
      </main>
    );
  }

  if (session.role === "field_officer") {
    if (session.mustChangePassword) {
      return (
        <FieldOfficerPasswordChange
          onComplete={async (next) => {
            await applySession(next);
          }}
          onSignOut={signOut}
        />
      );
    }
    return <FieldOfficerHome session={session} onSignOut={signOut} />;
  }

  if (session.role === "ngo" || session.role === "individual") {
    return <FieldConsole />;
  }

  // Stale sessions from older app builds (CA / gov / manager)
  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-brand">
          <ProductBrand
            size="sm"
            nameClassName="brand-name-on-light"
            poweredClassName="brand-powered-on-light"
          />
          <h1>Session outdated</h1>
        </div>
        <p className="login-status">
          This account type is no longer used in GRAM App. Sign out and sign in again with a supported account.
        </p>
        <div style={{ marginTop: "24px" }}>
          <button onClick={signOut} className="btn-secondary" style={{ width: "100%" }}>
            Sign Out
          </button>
        </div>
      </section>
      <AppFooter />
    </main>
  );
}
