import { NextRequest, NextResponse } from "next/server";
import { authenticateNgoWithPassword } from "@/lib/ngo-auth";
import {
  createSessionToken,
  getSessionCookieMaxAgeSeconds,
  SESSION_COOKIE_NAME,
} from "@/lib/session";
import { getSessionSecret, hasServerEnv } from "@/lib/env";
import { hasServerSupabaseEnv } from "@/lib/supabase-server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);
  const rateLimit = checkRateLimit({
    key: `login:${clientIp}`,
    limit: 10,
    windowMs: 10 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many login attempts. Please try again shortly." },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      },
    );
  }

  if (!hasServerSupabaseEnv() || !getSessionSecret()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Server login is not configured. Add NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, and SESSION_SECRET.",
      },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: string; password?: string, device_id?: string }
    | null;

  const email = body?.email?.trim() ?? "";
  const password = body?.password ?? "";

  if (!email || !password) {
    return NextResponse.json(
      { ok: false, error: "Email and password are required." },
      { status: 400 },
    );
  }

  const deviceId = body?.device_id ?? "";

  const authResult = await authenticateNgoWithPassword(email, password, deviceId);

  console.log(`[LOGIN_DEBUG] Email: ${email}, Allowed: ${authResult.allowed}, Reason: ${authResult.reason}`);
  if (!authResult.allowed) console.dir(authResult.debug, { depth: null });

  if (!authResult.allowed || !authResult.ngoId || !authResult.ngoName || !authResult.email) {
    return NextResponse.json(
      {
        ok: false,
        error: authResult.reason,
        debug: authResult.debug,
      },
      { status: 401 },
    );
  }

  const maxAge = getSessionCookieMaxAgeSeconds();
  const token = createSessionToken({
    id: authResult.ngoId?.toString() ?? "",
    name: authResult.ngoName ?? "",
    ngoId: authResult.ngoId ?? 0,
    ngoName: authResult.ngoName ?? "",
    email: authResult.email ?? "",
    role: (authResult.role ?? "ngo") as any,
    issuedAt: Date.now(),
    expiresAt: Date.now() + maxAge * 1000,
    deviceId: deviceId,
    createdAt: new Date().toISOString(),
    avatarUrl: authResult.avatarUrl ?? null,
  });

  const response = NextResponse.json({
    ok: true,
    session: {
      id: authResult.ngoId?.toString() ?? "",
      name: authResult.ngoName ?? "",
      ngoId: authResult.ngoId,
      ngoName: authResult.ngoName,
      email: authResult.email,
      role: authResult.role,
      deviceId: deviceId,
      createdAt: new Date().toISOString(),
      avatarUrl: authResult.avatarUrl ?? null,
    },
    debug: authResult.debug,
  });

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  });

  return response;
}