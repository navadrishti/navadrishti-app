import React from "react";
import type { Metadata, Viewport } from "next";
import { Manrope, IBM_Plex_Mono } from "next/font/google";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Navadrishti | Field Operations",
  description: "Secure, geo-tagged evidence collection for field operations.",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#1e3a8a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // We are inlining the CSS because the experimental Next.js 16 Webpack bundler 
  // currently has a module resolution conflict with global .css imports.
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: `
          :root {
            --font-sans: "Manrope", ui-sans-serif, system-ui;
            --bg: #f8fafc;
            --ink: #0f172a;
            --muted: #64748b;
            --line: #e2e8f0;
            --accent: #f97316;
            --brand-blue: #2563eb;
            --brand-blue-dark: #1e3a8a;
            --nav-blue: #0ea5e9;
            --nav-indigo: #6366f1;
          }
          * { box-sizing: border-box; }
          html, body { margin: 0; min-height: 100%; overflow-x: hidden; background: var(--bg); font-family: var(--font-sans); color: var(--ink); }
          
          /* Premium Login Design */
          .login-screen {
            min-height: 100vh; display: grid; place-items: center; padding: 24px;
            background: radial-gradient(circle at top left, #f8fafc 0%, #cbd5e1 100%);
            position: relative; overflow: hidden;
          }
          .login-card {
            width: min(440px, 100%); background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(16px); border-radius: 28px; padding: 48px;
            box-shadow: 0 25px 60px rgba(0,0,0,0.1); text-align: center; z-index: 10;
          }
          .login-brand { display: flex; flex-direction: column; align-items: center; gap: 20px; margin-bottom: 40px; }
          .login-brand-logo { width: 88px; height: 88px; object-fit: contain; }
          .login-card h1 { margin: 0; font-size: 2.2rem; font-weight: 900; color: #0f172a; letter-spacing: -0.03em; }
          .login-status { color: #64748b; font-size: 0.95rem; margin-top: 10px; font-weight: 500; }
          .login-form { display: grid; gap: 18px; text-align: left; }
          .login-form label { font-weight: 800; font-size: 0.75rem; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em; }
          .login-form input { width: 100%; padding: 14px; border: 1.5px solid #e2e8f0; border-radius: 14px; font-size: 1rem; }
          .login-form button { 
            background: linear-gradient(135deg, #6366f1 0%, #0ea5e9 100%);
            color: white; border: none; padding: 16px; border-radius: 14px; font-weight: 800; cursor: pointer;
            box-shadow: 0 10px 20px rgba(99, 102, 241, 0.2); transition: transform 0.2s;
          }
          .login-form button:hover { transform: translateY(-1px); }
          
          /* Dashboard Styles (Minimal for unblocking) */
          .app-header { background: var(--brand-blue-dark); color: white; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; }
          .context-panel { background: white; padding: 20px; border-bottom: 1px solid var(--line); }
          .evidence-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 20px; }
          .ev-card { background: white; border: 1px solid var(--line); border-radius: 16px; padding: 20px; }
          .btn-capture { background: var(--accent); color: white; border: none; padding: 12px; border-radius: 12px; font-weight: 700; width: 100%; cursor: pointer; }
        `}} />
      </head>
      <body className={`${manrope.variable} ${plexMono.variable}`}>{children}</body>
    </html>
  );
}
