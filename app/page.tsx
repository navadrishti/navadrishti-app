"use client";

import { useAppContext } from "@/components/app-provider";
import { FieldConsole } from "@/components/field-console";
import { AppFooter, ProductBrand } from "@/components/product-brand";
import { LoginBootstrapSkeleton } from "@/components/skeleton";
import { apiFetch } from "@/lib/env";
import { getDeviceId } from "@/lib/utils";
import type { AppSession } from "@/lib/types";
import { useState } from "react";

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
        applySession(data.session as AppSession);
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
            showFieldSuffix
            nameClassName="brand-name-on-light"
            poweredClassName="brand-powered-on-light"
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
