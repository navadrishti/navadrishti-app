import { NextRequest, NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import {
  clearSessionCookie,
  evaluateFieldOfficerSession,
  getVerifiedSessionFromRequest,
  hashPassword,
  MIN_FIELD_OFFICER_PASSWORD_LENGTH,
  setSessionCookie,
  verifyPassword,
} from "@/lib/field-officer-auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);
  const rateLimit = checkRateLimit({
    key: `fo-change-password:${clientIp}`,
    limit: 10,
    windowMs: 10 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
    );
  }

  const session = getVerifiedSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });
  }

  if (session.role !== "field_officer") {
    return NextResponse.json({ ok: false, error: "Insufficient permissions." }, { status: 403 });
  }

  let evaluation;
  try {
    evaluation = await evaluateFieldOfficerSession(session, { allowPasswordChangePending: true });
  } catch (error) {
    console.error("[api/auth/change-password] revalidation failed:", error);
    return NextResponse.json(
      { ok: false, error: "Sign-in is temporarily unavailable. Try again shortly." },
      { status: 500 }
    );
  }

  if (!evaluation.ok) {
    const response = NextResponse.json({ ok: false, error: evaluation.error }, { status: evaluation.status });
    if (evaluation.status === 401 || evaluation.error === "This account cannot sign in.") {
      clearSessionCookie(response);
    }
    return response;
  }

  const body = (await request.json().catch(() => null)) as
    | { currentPassword?: string; newPassword?: string }
    | null;

  const currentPassword = body?.currentPassword ?? "";
  const newPassword = body?.newPassword ?? "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { ok: false, error: "Current password and new password are required." },
      { status: 400 }
    );
  }

  if (newPassword.length < MIN_FIELD_OFFICER_PASSWORD_LENGTH) {
    return NextResponse.json(
      {
        ok: false,
        error: `New password must be at least ${MIN_FIELD_OFFICER_PASSWORD_LENGTH} characters.`,
      },
      { status: 400 }
    );
  }

  if (newPassword === currentPassword) {
    return NextResponse.json(
      { ok: false, error: "New password must be different from the current password." },
      { status: 400 }
    );
  }

  const supabase = getServerSupabaseClient();
  const userId = evaluation.identity.user_id;

  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("id, password")
    .eq("id", userId)
    .maybeSingle();

  if (userError || !userRow) {
    return NextResponse.json({ ok: false, error: "Unable to update password." }, { status: 500 });
  }

  const currentMatches = await verifyPassword(currentPassword, String(userRow.password ?? ""));
  if (!currentMatches) {
    // Failed change must leave must_change_password untouched.
    return NextResponse.json({ ok: false, error: "Current password is incorrect." }, { status: 400 });
  }

  const passwordHash = await hashPassword(newPassword);
  const now = new Date().toISOString();

  const { error: passwordUpdateError } = await supabase
    .from("users")
    .update({ password: passwordHash, updated_at: now })
    .eq("id", userId);

  if (passwordUpdateError) {
    console.error("[api/auth/change-password] password update failed:", passwordUpdateError);
    return NextResponse.json({ ok: false, error: "Unable to update password." }, { status: 500 });
  }

  const { data: identityUpdated, error: identityError } = await supabase
    .from("ngo_field_officer_identities")
    .update({
      must_change_password: false,
      updated_at: now,
    })
    .eq("id", evaluation.identity.id)
    .eq("user_id", userId)
    .select("id, must_change_password")
    .maybeSingle();

  if (identityError || !identityUpdated || identityUpdated.must_change_password !== false) {
    console.error("[api/auth/change-password] identity update failed:", identityError);
    return NextResponse.json({ ok: false, error: "Unable to update password." }, { status: 500 });
  }

  const nextSession = {
    ...evaluation.session,
    mustChangePassword: false,
  };

  const response = NextResponse.json({
    ok: true,
    session: {
      id: nextSession.id,
      name: nextSession.name,
      ngoId: nextSession.ngoId,
      ngoName: nextSession.ngoName,
      email: nextSession.email,
      role: nextSession.role,
      deviceId: nextSession.deviceId,
      createdAt: nextSession.createdAt,
      avatarUrl: nextSession.avatarUrl ?? null,
      identityId: nextSession.identityId,
      mustChangePassword: false,
      permissions: nextSession.permissions,
    },
  });
  setSessionCookie(response, nextSession);
  return response;
}
