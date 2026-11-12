import { NextRequest, NextResponse } from "next/server";
import { authenticateNgoWithPassword } from "@/lib/ngo-auth";
import {
  createSessionToken,
  getSessionCookieMaxAgeSeconds,
  SESSION_COOKIE_NAME,
  type AppSession,
} from "@/lib/session";
import { getSessionSecret, hasServerEnv } from "@/lib/env";
import { hasServerSupabaseEnv } from "@/lib/supabase-server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import type { SessionRole } from "@/lib/types";

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
      }
    );
  }

  if (!hasServerSupabaseEnv() || !getSessionSecret()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Server login is not configured. Add NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, and SESSION_SECRET.",
      },
      { status: 500 }
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: string; password?: string; device_id?: string }
    | null;

  const email = body?.email?.trim() ?? "";
  const password = body?.password ?? "";

  if (!email || !password) {
    return NextResponse.json(
      { ok: false, error: "Email and password are required." },
      { status: 400 }
    );
  }

  const deviceId = body?.device_id ?? "";

  const authResult = await authenticateNgoWithPassword(email, password, deviceId);

  if (
    !authResult.allowed ||
    !authResult.userId ||
    !authResult.ngoId ||
    !authResult.ngoName ||
    !authResult.email
  ) {
    if (authResult.debug.userLookupError || authResult.debug.ngoVerificationLookupError) {
      console.error("[api/login] lookup failed at stage", authResult.debug.stage);
    }
    return NextResponse.json({ ok: false, error: authResult.reason }, { status: 401 });
  }

  const role = (authResult.role ?? "ngo") as SessionRole;

  if (role === "field_officer" && !authResult.identityId) {
    return NextResponse.json({ ok: false, error: "This account cannot sign in." }, { status: 401 });
  }

  const maxAge = getSessionCookieMaxAgeSeconds();
  const now = Date.now();
  const session: AppSession = {
    id: String(authResult.userId),
    name: authResult.name || authResult.ngoName,
    ngoId: authResult.ngoId,
    ngoName: authResult.ngoName,
    email: authResult.email,
    role,
    issuedAt: now,
    expiresAt: now + maxAge * 1000,
    deviceId,
    createdAt: new Date().toISOString(),
    avatarUrl: authResult.avatarUrl ?? null,
    ...(role === "field_officer"
      ? {
          identityId: authResult.identityId,
          mustChangePassword: Boolean(authResult.mustChangePassword),
          permissions: authResult.permissions,
        }
      : {}),
  };

  const token = createSessionToken(session);

  const response = NextResponse.json({
    ok: true,
    session: {
      id: session.id,
      name: session.name,
      ngoId: session.ngoId,
      ngoName: session.ngoName,
      email: session.email,
      role: session.role,
      deviceId: session.deviceId,
      createdAt: session.createdAt,
      avatarUrl: session.avatarUrl ?? null,
      identityId: session.identityId,
      mustChangePassword: session.mustChangePassword,
      permissions: session.permissions,
    },
    ...(role === "field_officer" && session.mustChangePassword
      ? { mustChangePassword: true }
      : {}),
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
