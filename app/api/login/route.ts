import { NextRequest, NextResponse } from "next/server";
import { authenticateNgoWithPassword } from "@/lib/ngo-auth";
import {
  createSessionToken,
  getSessionCookieMaxAgeSeconds,
  SESSION_COOKIE_NAME,
} from "@/lib/session";
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

  if (!hasServerSupabaseEnv() || !process.env.APP_SESSION_SECRET) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Server login is not configured. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and APP_SESSION_SECRET.",
      },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: string; password?: string }
    | null;

  const email = body?.email?.trim() ?? "";
  const password = body?.password ?? "";

  if (!email || !password) {
    return NextResponse.json(
      { ok: false, error: "Email and password are required." },
      { status: 400 },
    );
  }

  const authResult = await authenticateNgoWithPassword(email, password);

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
    ngoId: authResult.ngoId,
    ngoName: authResult.ngoName,
    email: authResult.email,
    issuedAt: Date.now(),
    expiresAt: Date.now() + maxAge * 1000,
  });

  const response = NextResponse.json({
    ok: true,
    session: {
      ngoId: authResult.ngoId,
      ngoName: authResult.ngoName,
      email: authResult.email,
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