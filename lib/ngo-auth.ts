import bcrypt from "bcryptjs";
import { getServerSupabaseClient } from "@/lib/supabase-server";

interface NgoAuthDebugUser {
  id: number | null;
  email: string;
  userType: string;
  verified: boolean | null;
  emailVerified: boolean | null;
  phoneVerified: boolean | null;
  identityVerified: boolean | null;
  effectiveIdentityVerified?: boolean;
  effectiveIdentityReason?: string;
  verificationStatus: string;
  accountStatus: string;
}

export interface NgoAuthResult {
  allowed: boolean;
  reason: string;
  ngoId?: number;
  ngoName?: string;
  email?: string;
  debug: {
    stage: string;
    authEmail: string;
    userLookupError?: string;
    user: NgoAuthDebugUser | null;
    passwordMatched?: boolean;
    passwordFormat?: string;
    identityGatePassed?: boolean;
    identityGateReason?: string;
    ngoVerificationLookupError?: string;
    ngoVerificationStatus?: string;
  };
}

function normalizeStatus(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function detectPasswordFormat(storedPassword: string) {
  if (storedPassword.startsWith("$2a$") || storedPassword.startsWith("$2b$") || storedPassword.startsWith("$2y$")) {
    return "bcrypt";
  }

  return "plain";
}

async function comparePassword(inputPassword: string, storedPassword: string) {
  const passwordFormat = detectPasswordFormat(storedPassword);

  if (passwordFormat === "bcrypt") {
    return {
      passwordFormat,
      passwordMatched: await bcrypt.compare(inputPassword, storedPassword),
    };
  }

  return {
    passwordFormat,
    passwordMatched: storedPassword === inputPassword,
  };
}

export async function authenticateNgoWithPassword(
  email: string,
  password: string,
): Promise<NgoAuthResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const supabase = getServerSupabaseClient();
  const debug: NgoAuthResult["debug"] = {
    stage: "lookup-user",
    authEmail: normalizedEmail,
    user: null,
  };

  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select(
      "id, name, email, password, user_type, verified, email_verified, phone_verified, identity_verified, verification_status, account_status",
    )
    .ilike("email", normalizedEmail)
    .maybeSingle();

  debug.userLookupError = userError?.message;

  if (userError || !userRow) {
    return {
      allowed: false,
      reason: userError
        ? `Unable to load platform user record: ${userError.message}`
        : "Invalid email or password.",
      debug,
    };
  }

  debug.user = {
    id: typeof userRow.id === "number" ? userRow.id : null,
    email: typeof userRow.email === "string" ? userRow.email : normalizedEmail,
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

  debug.stage = "check-password";
  const passwordCheck = await comparePassword(password, String(userRow.password ?? ""));
  debug.passwordFormat = passwordCheck.passwordFormat;
  debug.passwordMatched = passwordCheck.passwordMatched;

  if (!debug.passwordMatched) {
    return {
      allowed: false,
      reason: "Invalid email or password.",
      debug,
    };
  }

  if (debug.user.userType !== "ngo") {
    return {
      allowed: false,
      reason: "Only NGO accounts can access the Navadrishti field app.",
      debug,
    };
  }

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

  if (debug.user.verificationStatus && debug.user.verificationStatus !== "verified") {
    return {
      allowed: false,
      reason: `User verification status is ${debug.user.verificationStatus}.`,
      debug,
    };
  }

  if (debug.user.accountStatus === "pending_verification") {
    return {
      allowed: false,
      reason: "Account status is pending verification.",
      debug,
    };
  }

  debug.stage = "lookup-ngo-verification";

  const { data: ngoVerif, error: ngoVerifError } = await supabase
    .from("ngo_verifications")
    .select("verification_status, ngo_name")
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

  const identityGatePassed = Boolean(userRow.identity_verified) || debug.ngoVerificationStatus === "verified";
  debug.identityGatePassed = identityGatePassed;
  debug.identityGateReason = userRow.identity_verified
    ? "users.identity_verified is true"
    : debug.ngoVerificationStatus === "verified"
      ? "ngo_verifications.verification_status is verified"
      : "No identity verification signal matched";
  if (debug.user) {
    debug.user.effectiveIdentityVerified = identityGatePassed;
    debug.user.effectiveIdentityReason = debug.identityGateReason;
  }

  if (!identityGatePassed) {
    return {
      allowed: false,
      reason: "Identity verification is incomplete for this NGO account.",
      debug,
    };
  }

  if (debug.ngoVerificationStatus !== "verified") {
    return {
      allowed: false,
      reason: `NGO verification is ${debug.ngoVerificationStatus || "unknown"}. Only fully verified NGOs can access the field app.`,
      debug,
    };
  }

  return {
    allowed: true,
    reason: "OK",
    ngoId: userRow.id as number,
    ngoName:
      (typeof ngoVerif.ngo_name === "string" && ngoVerif.ngo_name.trim()) ||
      (typeof userRow.name === "string" ? userRow.name : normalizedEmail),
    email: typeof userRow.email === "string" ? userRow.email : normalizedEmail,
    debug: {
      ...debug,
      stage: "authenticated",
    },
  };
}