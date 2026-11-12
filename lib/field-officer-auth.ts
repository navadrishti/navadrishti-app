import bcrypt from "bcryptjs";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { getAccountAccessBlockReason } from "@/lib/account-access";
import {
  createSessionToken,
  getSessionCookieMaxAgeSeconds,
  SESSION_COOKIE_NAME,
  verifySessionToken,
  type AppSession,
} from "@/lib/session";

export const FIELD_OFFICER_PROFILE_ROLE = "ngo_field_officer" as const;
export const FIELD_OFFICER_PASSWORD_CHANGE_REQUIRED_MESSAGE =
  "Password change required before continuing.";

export type FieldOfficerPermission = "can_submit_field_evidence";

export type FieldOfficerIdentityRow = {
  id: string;
  user_id: number;
  ngo_user_id: number;
  status: string;
  permissions: unknown;
  must_change_password: boolean;
  last_login_at: string | null;
  deactivated_at: string | null;
};

export type FieldOfficerPermissions = {
  can_submit_field_evidence: boolean;
};

/** Missing or malformed permission values default to deny. */
export function fieldOfficerHasPermission(
  permissions: unknown,
  key: FieldOfficerPermission
): boolean {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    return false;
  }
  return (permissions as Record<string, unknown>)[key] === true;
}

export function normalizeFieldOfficerPermissions(permissions: unknown): FieldOfficerPermissions {
  return {
    can_submit_field_evidence: fieldOfficerHasPermission(permissions, "can_submit_field_evidence"),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function profileClaimsFieldOfficerRole(profileData: unknown): boolean {
  return String(asObject(profileData).role || "").trim().toLowerCase() === FIELD_OFFICER_PROFILE_ROLE;
}

export async function findFieldOfficerIdentityByUserId(
  userId: number
): Promise<FieldOfficerIdentityRow | null> {
  const supabase = getServerSupabaseClient();
  const { data, error } = await supabase
    .from("ngo_field_officer_identities")
    .select(
      "id, user_id, ngo_user_id, status, permissions, must_change_password, last_login_at, deactivated_at"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: String(data.id),
    user_id: Number(data.user_id),
    ngo_user_id: Number(data.ngo_user_id),
    status: String(data.status || "").trim().toLowerCase(),
    permissions: data.permissions,
    must_change_password: Boolean(data.must_change_password),
    last_login_at: data.last_login_at == null ? null : String(data.last_login_at),
    deactivated_at: data.deactivated_at == null ? null : String(data.deactivated_at),
  };
}

export async function touchFieldOfficerLastLogin(identityId: string): Promise<void> {
  const supabase = getServerSupabaseClient();
  const { error } = await supabase
    .from("ngo_field_officer_identities")
    .update({
      last_login_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", identityId);

  if (error) {
    console.error("[field-officer-auth] failed to update last_login_at:", error);
  }
}

export type FieldOfficerSessionEvaluation =
  | { ok: true; session: AppSession; identity: FieldOfficerIdentityRow }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Re-load identity from DB. Never trust cookie role/permissions/ngoId alone.
 */
export async function evaluateFieldOfficerSession(
  session: AppSession,
  options: { allowPasswordChangePending?: boolean } = {}
): Promise<FieldOfficerSessionEvaluation> {
  if (session.role !== "field_officer") {
    return { ok: false, status: 403, error: "Field officer session required." };
  }

  const userId = Number(session.id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return { ok: false, status: 401, error: "Authentication required." };
  }

  const supabase = getServerSupabaseClient();
  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("id, name, email, user_type, account_status, locked_until, profile_data, profile_image")
    .eq("id", userId)
    .maybeSingle();

  if (userError) throw userError;
  if (!userRow || String(userRow.user_type || "").toLowerCase() !== "individual") {
    return { ok: false, status: 401, error: "Authentication required." };
  }

  const blockReason = getAccountAccessBlockReason(userRow);
  if (blockReason) {
    return { ok: false, status: 403, error: blockReason };
  }

  const identity = await findFieldOfficerIdentityByUserId(userId);
  if (!identity || identity.status !== "active") {
    return { ok: false, status: 403, error: "This account cannot sign in." };
  }

  if (identity.must_change_password && !options.allowPasswordChangePending) {
    return { ok: false, status: 403, error: FIELD_OFFICER_PASSWORD_CHANGE_REQUIRED_MESSAGE };
  }

  const { data: parentNgo, error: parentError } = await supabase
    .from("users")
    .select("id, name, user_type, account_status, locked_until, profile_data")
    .eq("id", identity.ngo_user_id)
    .maybeSingle();
  if (parentError) throw parentError;
  if (!parentNgo || String(parentNgo.user_type || "").toLowerCase() !== "ngo") {
    return { ok: false, status: 403, error: "Parent NGO account is not available." };
  }
  const parentBlock = getAccountAccessBlockReason(parentNgo);
  if (parentBlock) {
    return { ok: false, status: 403, error: parentBlock };
  }

  const permissions = normalizeFieldOfficerPermissions(identity.permissions);
  const refreshed: AppSession = {
    ...session,
    id: String(userId),
    name:
      (typeof userRow.name === "string" && userRow.name.trim()) ||
      (typeof userRow.email === "string" ? userRow.email : session.name),
    email: typeof userRow.email === "string" ? userRow.email : session.email,
    // Parent NGO always from DB identity — never from client/cookie alone.
    ngoId: identity.ngo_user_id,
    ngoName:
      (typeof parentNgo.name === "string" && parentNgo.name.trim()) || session.ngoName,
    role: "field_officer",
    identityId: identity.id,
    mustChangePassword: identity.must_change_password,
    permissions,
  };

  return { ok: true, session: refreshed, identity };
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export function setSessionCookie(response: NextResponse, session: AppSession) {
  const maxAge = getSessionCookieMaxAgeSeconds();
  const token = createSessionToken({
    ...session,
    issuedAt: Date.now(),
    expiresAt: Date.now() + maxAge * 1000,
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
}

export function getVerifiedSessionFromRequest(request: NextRequest): AppSession | null {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(input: string, stored: string): Promise<boolean> {
  if (
    !stored.startsWith("$2a$") &&
    !stored.startsWith("$2b$") &&
    !stored.startsWith("$2y$")
  ) {
    return false;
  }
  return bcrypt.compare(input, stored);
}

export const MIN_FIELD_OFFICER_PASSWORD_LENGTH = 8;
