"use client";

import { FIELD_APP_NAME } from "@/lib/env";

/**
 * Replaces the root layout when a fatal render error escapes.
 * Must include its own <html>/<body> and must not rely on AppProvider.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: 24,
          fontFamily: "system-ui, sans-serif",
          background: "#F6F5F1",
          color: "#3F474E",
        }}
      >
        <main style={{ maxWidth: 420, width: "100%", textAlign: "center" }}>
          <h1 style={{ margin: "0 0 8px", fontSize: "1.25rem", color: "#2C3338" }}>
            {FIELD_APP_NAME} could not load
          </h1>
          <p style={{ margin: "0 0 16px", fontSize: "0.9rem", lineHeight: 1.5 }}>
            A temporary error stopped this screen. Your saved offline records stay on this device.
          </p>
          {error?.digest ? (
            <p style={{ margin: "0 0 16px", fontSize: "0.75rem", color: "#6E777E" }}>
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              border: 0,
              borderRadius: 8,
              padding: "12px 18px",
              background: "#F47B20",
              color: "#fff",
              fontWeight: 600,
              minHeight: 44,
              width: "100%",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
