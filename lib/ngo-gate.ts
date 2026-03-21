import { SupabaseClient } from "@supabase/supabase-js";

export interface NgoGateResult {
  allowed: boolean;
  reason: string;
  ngoId?: number;
  ngoName?: string;
  debug?: {
    authEmail: string;
    userLookupError?: string;
    user?: {
      id: number | null;
      email: string;
      userType: string;
      verified: boolean | null;
      emailVerified: boolean | null;
      phoneVerified: boolean | null;
      identityVerified: boolean | null;
      verificationStatus: string;
      accountStatus: string;
    } | null;
    ngoVerificationLookupError?: string;
    ngoVerificationStatus?: string;
  };
}

function normalizeStatus(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * After Supabase Auth sign-in succeeds, verify the authenticated email
 * belongs to an NGO account that has been fully verified on the platform.
 *
 * Gate conditions (all must pass):
 *  1. A record exists in public.users with this email and user_type = 'ngo'
 *  2. users.email_verified = true
 *  3. users.phone_verified = true
 *  4. users.identity_verified = true
 *  5. users.verification_status = 'verified'
 *  6. ngo_verifications.verification_status = 'verified'
 */
export async function checkNgoGate(
  supabase: SupabaseClient,
  authEmail: string,
): Promise<NgoGateResult> {
  const debug: NonNullable<NgoGateResult["debug"]> = {
    authEmail,
    user: null,
  };

  // Step 1: fetch the platform user record by email
  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select(
      "id, name, email, user_type, verified, email_verified, phone_verified, identity_verified, verification_status, account_status",
    )
    .ilike("email", authEmail)
    .maybeSingle();

  debug.userLookupError = userError?.message;

  if (userError || !userRow) {
    return {
      allowed: false,
      reason: userError
        ? `Unable to load platform user record: ${userError.message}`
        : "Account not found on the platform. Sign up at the main Navadrishti site first.",
      debug,
    };
  }

  debug.user = {
    id: typeof userRow.id === "number" ? userRow.id : null,
    email: typeof userRow.email === "string" ? userRow.email : "",
    userType: normalizeStatus(userRow.user_type),
    verified: typeof userRow.verified === "boolean" ? userRow.verified : null,
    emailVerified:
      typeof userRow.email_verified === "boolean" ? userRow.email_verified : null,
    phoneVerified:
      typeof userRow.phone_verified === "boolean" ? userRow.phone_verified : null,
    identityVerified:
      typeof userRow.identity_verified === "boolean" ? userRow.identity_verified : null,
    verificationStatus: normalizeStatus(userRow.verification_status),
    accountStatus: normalizeStatus(userRow.account_status),
  };

  const userType = normalizeStatus(userRow.user_type);
  if (userType !== "ngo") {
    return {
      allowed: false,
      reason: "Only NGO accounts can access the Navadrishti field app.",
      debug,
    };
  }

  const accountVerificationStatus = normalizeStatus(userRow.verification_status);
  const accountStatus = normalizeStatus(userRow.account_status);

  if (!userRow.email_verified) {
    return {
      allowed: false,
      reason: "Email is not verified for this NGO account.",
      debug,
    };
  }

  if (!userRow.phone_verified) {
    return {
      allowed: false,
      reason: "Phone is not verified for this NGO account.",
      debug,
    };
  }

  if (!userRow.identity_verified) {
    return {
      allowed: false,
      reason: "Identity verification is incomplete for this NGO account.",
      debug,
    };
  }

  if (accountVerificationStatus && accountVerificationStatus !== "verified") {
    return {
      allowed: false,
      reason: `User verification status is ${accountVerificationStatus}.`,
      debug,
    };
  }

  if (accountStatus && accountStatus === "pending_verification") {
    return {
      allowed: false,
      reason: "Account status is pending verification.",
      debug,
    };
  }

  // Step 2: check NGO-specific verification record
  const { data: ngoVerif, error: ngoVerifError } = await supabase
    .from("ngo_verifications")
    .select("verification_status")
    .eq("user_id", userRow.id)
    .maybeSingle();

  debug.ngoVerificationLookupError = ngoVerifError?.message;
  debug.ngoVerificationStatus = normalizeStatus(ngoVerif?.verification_status);

  if (ngoVerifError || !ngoVerif) {
    return {
      allowed: false,
      reason: ngoVerifError
        ? `Unable to load NGO verification record: ${ngoVerifError.message}`
        : "NGO verification record not found. Complete your NGO profile on the platform.",
      debug,
    };
  }

  const ngoVerificationStatus = normalizeStatus(ngoVerif.verification_status);

  if (ngoVerificationStatus !== "verified") {
    const statusLabel =
      ngoVerificationStatus === "pending"
        ? "pending review"
        : ngoVerificationStatus === "rejected"
          ? "rejected"
          : ngoVerificationStatus;
    return {
      allowed: false,
      reason: `NGO verification is ${statusLabel}. Only fully verified NGOs can access the field app.`,
      debug,
    };
  }

  return {
    allowed: true,
    reason: "OK",
    ngoId: userRow.id as number,
    ngoName: userRow.name as string,
    debug,
  };
}
