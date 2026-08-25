/**
 * Environment + brand constants — aligned with main GRAM platform naming.
 * PWA talks to the same Supabase schema (users, csr_projects, campaigns,
 * service_engagement_assignments, events, …) and optionally the platform
 * API gateway at /api/pwa/*.
 */

export const PRODUCT_NAME = 'GRAM';
export const COMPANY_LEGAL_NAME = 'Navadrishti LLP';
export const PRODUCT_POWERED_BY = 'Powered by Navadrishti';
export const PRODUCT_LOGO_SRC = '/Gram.svg';
export const PRODUCT_LOGO_ALT = `${PRODUCT_NAME} logo`;
export const PRODUCT_BRAND_CLASSNAME = 'product-brand';
export const FIELD_APP_NAME = `${PRODUCT_NAME} App`;

export function getSupabaseUrl(): string {
  return (
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    ""
  );
}

/** Server-side Supabase admin key */
export function getSupabaseServiceKey(): string {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SECRET_KEY ??
    ""
  );
}

/** Browser Supabase key (anon / publishable) */
export function getSupabasePublishableKey(): string {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    ""
  );
}

/** HMAC session signing secret — use the same value as the main platform when sharing auth. */
export function getSessionSecret(): string {
  return (
    process.env.APP_SESSION_SECRET ??
    process.env.SESSION_SECRET ??
    process.env.JWT_SECRET ??
    ""
  );
}

/** This field app's own public URL */
export function getAppUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    process.env.FRONTEND_URL ??
    "";
  return raw.replace(/\/$/, "");
}

/**
 * Main GRAM web platform URL (separate host).
 * Used for "Open platform" links — not for API unless PLATFORM_API is unset.
 */
export function getPlatformUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_PLATFORM_URL ??
    process.env.PLATFORM_URL ??
    "";
  return raw.replace(/\/$/, "");
}

/**
 * Optional: call field APIs through the main platform gateway (`/api/pwa/...`)
 * instead of this app's own `/api/...` routes.
 * Example: https://app.navadrishti.in
 */
export function getPlatformApiUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_PLATFORM_API_URL ??
    process.env.PLATFORM_API_URL ??
    "";
  return raw.replace(/\/$/, "");
}

/** Session cookie max-age in seconds (default 7 days) */
export function getSessionMaxAgeSeconds(): number {
  const ms = process.env.SESSION_MAX_AGE;
  if (ms && !Number.isNaN(Number(ms))) {
    return Math.floor(Number(ms) / 1000);
  }

  const jwtExpires = process.env.JWT_EXPIRES_IN;
  if (jwtExpires === "7d") return 60 * 60 * 24 * 7;
  if (jwtExpires === "30d") return 60 * 60 * 24 * 30;

  return 60 * 60 * 24 * 7;
}

export function getMissingServerEnv(): string[] {
  const missing: string[] = [];

  if (!getSupabaseUrl()) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)");
  }

  if (!getSupabaseServiceKey()) {
    missing.push("SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)");
  }

  if (!getSessionSecret()) {
    missing.push("SESSION_SECRET (or APP_SESSION_SECRET / JWT_SECRET)");
  }

  return missing;
}

export function hasServerEnv(): boolean {
  return getMissingServerEnv().length === 0;
}

export function hasBrowserSupabaseEnv(): boolean {
  return Boolean(getSupabaseUrl() && getSupabasePublishableKey());
}

/**
 * Base URL for API calls.
 * Browser on PWA host → relative `/api/...` (same origin),
 * or platform gateway when NEXT_PUBLIC_PLATFORM_API_URL is configured.
 */
export function getApiBaseUrl(): string {
  const platformApi = getPlatformApiUrl();
  if (platformApi) return platformApi;
  if (typeof window !== "undefined") return "";
  return getAppUrl();
}

/**
 * Build an API URL.
 * Local PWA routes: `/api/login`
 * Via platform gateway: `{PLATFORM}/api/pwa/login`
 */
export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const platformApi = getPlatformApiUrl();
  const base = getApiBaseUrl();

  if (platformApi) {
    const gatewayPath = normalizedPath.startsWith("/api/pwa/")
      ? normalizedPath
      : normalizedPath.replace(/^\/api\//, "/api/pwa/");
    return `${platformApi}${gatewayPath}`;
  }

  return base ? `${base}${normalizedPath}` : normalizedPath;
}

/** fetch wrapper — always sends cookies for session auth across PWA / platform gateway. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), {
    ...init,
    credentials: "include",
  });
}
