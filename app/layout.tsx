import React from "react";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { AppProvider } from "@/components/app-provider";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Navadrishti | Field Cockpit",
  description: "Secure Evidence Ingestion PWA",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover"
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: `
          :root {
            --primary: #3b82f6;
            --primary-hover: #2563eb;
            --bg-app: #f8fafc;
            --card-bg: rgba(255, 255, 255, 0.9);
            --glass: rgba(255, 255, 255, 0.7);
            --glass-border: rgba(255, 255, 255, 0.4);
            --text-main: #0f172a;
            --text-muted: #64748b;
            --line: #e2e8f0;
            --radius-sm: 8px;
            --radius-md: 14px;
            --radius-lg: 24px;
            --shadow-sm: 0 2px 4px rgba(0,0,0,0.05);
            --shadow-md: 0 10px 25px rgba(0,0,0,0.08);
            --success: #10b981;
            --warning: #f59e0b;
            --error: #ef4444;
          }

          * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
          body { background: var(--bg-app); color: var(--text-main); line-height: 1.5; min-height: 100vh; overflow-x: hidden; }

          .app { max-width: 500px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; padding-bottom: 60px; position: relative; }

          /* Header */
          .app-header {
            position: sticky; top: 0; z-index: 100;
            background: rgba(255, 255, 255, 0.8); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
            border-bottom: 1px solid var(--line); padding: 14px 20px;
            display: flex; justify-content: space-between; align-items: center;
          }
          .header-left { display: flex; align-items: center; gap: 12px; }
          .header-logo { width: 32px; height: 32px; object-fit: contain; }
          .header-org { font-size: 1.1rem; font-weight: 900; letter-spacing: -0.03em; }
          .header-meta { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }

          /* Cards & Sections */
          .card-section { background: var(--card-bg); margin: 16px; padding: 24px; border-radius: var(--radius-lg); border: 1px solid var(--line); box-shadow: var(--shadow-md); }
          .section-title { font-size: 0.8rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 20px; display: block; }

          /* Action Chips */
          .chips-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
          .chip { padding: 8px 16px; border-radius: 100px; font-size: 0.8rem; font-weight: 700; background: #fff; border: 1px solid var(--line); display: flex; align-items: center; gap: 8px; box-shadow: var(--shadow-sm); }
          .chip-dot { width: 8px; height: 8px; border-radius: 50%; }
          .dot-online { background: var(--success); box-shadow: 0 0 10px var(--success); }
          .dot-offline { background: var(--error); }
          .dot-syncing { background: var(--primary); animation: pulse 1.5s infinite; }

          @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }

          /* Viewfinder UI */
          .viewfinder { position: relative; width: 100%; aspect-ratio: 4/3; background: #000; border-radius: var(--radius-md); overflow: hidden; margin-bottom: 20px; box-shadow: inset 0 0 40px rgba(0,0,0,0.5); }
          .viewfinder video { width: 100%; height: 100%; object-fit: cover; }
          .viewfinder-overlay { position: absolute; inset: 0; border: 1px solid rgba(255,255,255,0.1); pointer-events: none; }
          .v-corner { position: absolute; width: 24px; height: 24px; border: 2px solid rgba(255,255,255,0.5); }
          .t-l { top: 20px; left: 20px; border-right: 0; border-bottom: 0; }
          .t-r { top: 20px; right: 20px; border-left: 0; border-bottom: 0; }
          .b-l { bottom: 20px; left: 20px; border-right: 0; border-top: 0; }
          .b-r { bottom: 20px; right: 20px; border-left: 0; border-top: 0; }

          /* Modern Buttons */
          .btn-primary { background: var(--primary); color: #fff; padding: 16px; border-radius: 16px; font-weight: 800; width: 100%; font-size: 1rem; border: none; box-shadow: 0 8px 20px rgba(59, 130, 246, 0.25); }
          .btn-primary:active { transform: scale(0.98); }
          .btn-primary:disabled { background: var(--text-muted); opacity: 0.5; }

          .btn-shutter { width: 72px; height: 72px; border-radius: 50%; background: #fff; border: 5px solid var(--primary); display: grid; place-items: center; margin: 0 auto; box-shadow: 0 10px 25px rgba(0,0,0,0.15); }
          .btn-shutter-inner { width: 52px; height: 52px; border-radius: 50%; background: var(--error); transition: transform 0.1s; }
          .btn-shutter:active .btn-shutter-inner { transform: scale(0.9); }

          .btn-outline { padding: 8px 16px; border-radius: 12px; border: 1.5px solid var(--line); background: #fff; font-size: 0.85rem; font-weight: 700; color: var(--text-main); }
          /* Modern Login Design */
          .login-screen {
            min-height: 100vh; display: grid; place-items: center; padding: 20px;
            background: radial-gradient(circle at top left, #f8fafc 0%, #cbd5e1 100%);
            position: relative; overflow: hidden;
          }
          .login-card {
            width: min(400px, 100%); background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(16px); border-radius: 32px; padding: 40px 32px;
            box-shadow: 0 25px 60px rgba(0,0,0,0.1); text-align: center; z-index: 10;
            border: 1px solid rgba(255,255,255,0.5);
          }
          .login-brand { display: flex; flex-direction: column; align-items: center; gap: 16px; margin-bottom: 32px; }
          .login-brand-logo { width: 64px; height: 64px; object-fit: contain; }
          .login-card h1 { margin: 0; font-size: 1.8rem; font-weight: 900; color: #0f172a; letter-spacing: -0.04em; }
          .login-status { color: #64748b; font-size: 0.9rem; margin-top: 8px; font-weight: 600; }
          
          .login-form { display: grid; gap: 20px; text-align: left; }
          .login-form label { font-weight: 800; font-size: 0.75rem; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em; padding-left: 4px; }
          .login-form input { width: 100%; padding: 14px 18px; border: 1.5px solid #e2e8f0; border-radius: 16px; font-size: 1rem; transition: all 0.2s; }
          .login-form input:focus { border-color: var(--primary); outline: none; box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1); }
          
          .login-form button { 
            background: var(--primary);
            color: white; border: none; padding: 16px; border-radius: 16px; font-weight: 800; cursor: pointer;
            font-size: 1rem; box-shadow: 0 10px 25px rgba(59, 130, 246, 0.2); transition: all 0.2s;
          }
          .login-form button:active { transform: scale(0.98); }
          .login-form button:disabled { opacity: 0.5; cursor: not-allowed; }

          .form-error { background: #fef2f2; color: #b91c1c; padding: 12px; border-radius: 12px; font-size: 0.85rem; font-weight: 700; border: 1px solid #fecaca; margin-bottom: 10px; }

          /* Form Controls */
          .form-group { margin-bottom: 20px; }
          .form-group label { display: block; font-size: 0.75rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; padding-left: 4px; }
          input, select, textarea { width: 100%; padding: 14px 18px; border-radius: 16px; border: 1.5px solid var(--line); font: inherit; background: #fff; box-shadow: var(--shadow-sm); transition: all 0.2s; }
          input:focus, select:focus, textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1); }

          /* Ledger List */
          .ledger-item { display: flex; align-items: center; gap: 16px; padding: 16px; background: #fff; border: 1px solid var(--line); border-radius: 20px; margin-bottom: 12px; box-shadow: var(--shadow-sm); }
          .ledger-thumb { width: 56px; height: 56px; border-radius: 12px; object-fit: cover; background: var(--bg-app); border: 1px solid var(--line); }
          .ledger-info { flex: 1; min-width: 0; }
          .ledger-title { font-size: 0.95rem; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .ledger-meta { font-size: 0.8rem; color: var(--text-muted); font-weight: 500; }
          .status-badge { font-size: 0.65rem; font-weight: 900; padding: 4px 10px; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
          .status-synced { background: #d1fae5; color: #065f46; }
          .status-pending { background: #fef3c7; color: #92400e; }
          .status-syncing { background: #dbeafe; color: #1e40af; }

          /* Special Badges */
          .badge { padding: 4px 10px; border-radius: 8px; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; }
          .badge-blue { background: #eff6ff; color: #1d4ed8; }
          .badge-slate { background: #f1f5f9; color: #475569; }
        ` }} />
      </head>
      <body className={inter.className}>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
