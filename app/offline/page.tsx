"use client";

import React from "react";

export default function OfflinePage() {
  return (
    <main className="login-screen" style={{ textAlign: "center" }}>
      <section className="login-card">
        <div className="login-brand" style={{ flexDirection: "column", gap: "24px" }}>
          <img 
            className="login-brand-logo" 
            src="/logo.svg" 
            alt="Navadrishti logo" 
            style={{ width: "80px", height: "80px" }}
          />
          <h1 style={{ fontSize: "2rem" }}>You're Offline</h1>
          <p style={{ color: "var(--muted)", margin: "0" }}>
            Navadrishti is designed for the field. You can still use the app to capture evidence; 
            it will sync automatically when you're back in range.
          </p>
          <button 
            type="button" 
            onClick={() => window.location.reload()}
            style={{
              padding: "12px 24px",
              background: "var(--brand-blue)",
              color: "white",
              border: "none",
              borderRadius: "12px",
              fontWeight: "700",
              cursor: "pointer"
            }}
          >
            Check Connection
          </button>
        </div>
      </section>
    </main>
  );
}
