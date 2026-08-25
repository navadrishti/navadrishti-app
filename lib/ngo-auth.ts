import bcrypt from "bcryptjs";
import { getServerSupabaseClient } from "@/lib/supabase-server";

interface AuthDebugUser {
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
  role?: string;
  debug: {
    stage: string;
    authEmail: string;
    userLookupError?: string;
    user: AuthDebugUser | null;
    passwordMatched?: boolean;
    passwordFormat?: string;
    identityGatePassed?: boolean;
    identityGateReason?: string;
    ngoVerificationLookupError?: string;
    ngoVerificationStatus?: string;
    individualVerificationStatus?: string;
  };
}

const FIELD_APP_ROLES = new Set(["ngo", "individual"]);

function normalizeStatus(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function detectPasswordFormat(storedPassword: string) {
  if (
    storedPassword.startsWith("$2a$") ||
    storedPassword.startsWith("$2b$") ||
    storedPassword.startsWith("$2y$")
  ) {
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
  deviceId?: string
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
      "id, name, email, password, user_type, verified, email_verified, phone_verified, identity_verified, verification_status, account_status, device_id, profile_data"
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

  const userType = normalizeStatus(userRow.user_type);

  debug.user = {
    id: typeof userRow.id === "number" ? userRow.id : null,
    email: typeof userRow.email === "string" ? userRow.email : normalizedEmail,
    userType,
    verified: typeof userRow.verified === "boolean" ? userRow.verified : null,
    emailVerified: typeof userRow.email_verified === "boolean" ? userRow.email_verified : null,
    phoneVerified: typeof userRow.phone_verified === "boolean" ? userRow.phone_verified : null,
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

  if (!FIELD_APP_ROLES.has(userType)) {
    return {
      allowed: false,
      reason: "This account cannot access the field app.",
      debug,
    };
  }

  if (!userRow.email_verified) {
    return {
      allowed: false,
      reason: "Email is not verified. Verify your email on the platform, then try again.",
      debug,
    };
  }

  const accountStatus = debug.user.accountStatus;
  if (accountStatus && ["banned", "suspended", "locked", "deactivated"].includes(accountStatus)) {
    return {
      allowed: false,
      reason: `Account is ${accountStatus}. Contact support if this looks wrong.`,
      debug,
    };
  }

  const displayName =
    (typeof userRow.name === "string" && userRow.name.trim()) || normalizedEmail;

  if (userType === "ngo") {
    if (deviceId) {
      const storedDeviceId = userRow.device_id;
      if (!storedDeviceId) {
        await supabase.from("users").update({ device_id: deviceId }).eq("id", userRow.id);
      } else if (storedDeviceId !== deviceId) {
        return {
          allowed: false,
          reason:
            "Access Denied: This account is locked to a different device. Contact administration for a hardware transfer.",
          debug,
        };
      }
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
          ? `Unable to load verification record: ${ngoVerifError.message}`
          : "Verification record not found. Complete your profile on the platform.",
        debug,
      };
    }

    const identityGatePassed =
      Boolean(userRow.identity_verified) || debug.ngoVerificationStatus === "verified";
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

    if (!identityGatePassed || debug.ngoVerificationStatus !== "verified") {
      return {
        allowed: false,
        reason: `Verification is ${debug.ngoVerificationStatus || "incomplete"}. Fully verified accounts can access the field app.`,
        debug,
      };
    }

    return {
      allowed: true,
      reason: "OK",
      ngoId: userRow.id as number,
      role: "ngo",
      ngoName:
        (typeof ngoVerif?.ngo_name === "string" && ngoVerif.ngo_name.trim()) || displayName,
      email: typeof userRow.email === "string" ? userRow.email : normalizedEmail,
      debug: { ...debug, stage: "authenticated" },
    };
  }

  // individual
  debug.stage = "lookup-individual";
  const { data: indVerif } = await supabase
    .from("individual_verifications")
    .select("verification_status")
    .eq("user_id", userRow.id)
    .maybeSingle();

  debug.individualVerificationStatus =
    normalizeStatus(indVerif?.verification_status) ||
    normalizeStatus(userRow.verification_status) ||
    undefined;

  return {
    allowed: true,
    reason: "OK",
    ngoId: userRow.id as number,
    role: "individual",
    ngoName: displayName,
    email: typeof userRow.email === "string" ? userRow.email : normalizedEmail,
    debug: { ...debug, stage: "authenticated" },
  };
}
