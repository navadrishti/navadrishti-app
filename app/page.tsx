"use client";

import { useAppContext } from "@/components/app-provider";
import { FieldConsole } from "@/components/field-console";
import { ManagerConsole } from "@/components/manager-console";
import { useState } from "react";

export default function HomePage() {
  const { ready, session, sessionLoading, configured, missingEnv, signOut } = useAppContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      
      if (data.session) {
        window.localStorage.setItem("navadrishti.session", JSON.stringify(data.session));
      }
      
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid credentials");
    } finally {
      setLoading(false);
    }
  }

  if (sessionLoading) {
    return (
      <main className="login-screen">
        <section className="login-card">
          <div className="login-brand">
            <img className="login-brand-logo" src="/logo.svg" alt="ND" />
            <h1>Navadrishti</h1>
            <p className="login-status">Authenticating Terminal...</p>
          </div>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="login-screen">
        <section className="login-card">
          <div className="login-brand">
            <img className="login-brand-logo" src="/logo.svg" alt="ND" />
            <h1>Navadrishti</h1>
            <p style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: '4px' }}>
              Field Ops Console
            </p>
          </div>

          {!configured && (
            <div className="form-error">
              Infrastructure unconfigured. Check environment variables.
            </div>
          )}

          <form className="login-form" onSubmit={handleLogin}>
            <div className="form-group">
              <label htmlFor="email">Operator Email</label>
              <input
                id="email"
                type="email"
                placeholder="operator@navadrishti.org"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">Security Key</label>
              <input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {error && <div className="form-error">{error}</div>}

            <button type="submit" disabled={loading || !configured}>
              {loading ? "Verifying..." : "Initialize Session"}
            </button>
          </form>

          <p style={{ marginTop: '32px', fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>
            Secure End-to-End Encrypted Ingestion
          </p>
        </section>
      </main>
    );
  }

  // Role-based routing
  if (session.role === "field" || session.role === "gov" || session.role === "ngo") {
    return <FieldConsole />;
  }

  if (session.role === "ca" || session.role === "manager") {
    return <ManagerConsole />;
  }

  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-brand">
          <img className="login-brand-logo" src="/logo.svg" alt="ND" />
          <h1>Terminal Active</h1>
        </div>
        <p className="login-status">Welcome back, {session.name}.</p>
        <div style={{ marginTop: '32px' }}>
          <button onClick={signOut} className="btn-outline" style={{ width: '100%' }}>Terminate Session</button>
        </div>
      </section>
    </main>
  );
}
