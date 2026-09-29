import path from "node:path";
import { fileURLToPath } from "node:url";
import withPWAInit from "@ducanh2912/next-pwa";

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

const withPWA = withPWAInit({
  dest: "public",
  register: true,
  // Keep SW off in `next dev`; enable it for production / Vercel builds.
  disable: process.env.NODE_ENV === "development",
  cacheOnFrontEndNav: true,
  extendDefaultRuntimeCaching: true,
  workboxOptions: {
    // API responses are per-user; offline data lives in IndexedDB, never in the SW cache.
    runtimeCaching: [
      {
        urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
        method: "GET",
      },
    ],
  },
  fallbacks: {
    document: "/offline"
  }
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typedRoutes: false,
  outputFileTracingRoot: workspaceRoot,
  devIndicators: false,
};

export default withPWA(nextConfig);
