import bcrypt from "bcryptjs";
import { resolveUserAvatarUrl } from "@/lib/utils";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { getAccountAccessBlockReason } from "@/lib/account-access";
import {
  findFieldOfficerIdentityByUserId,
  normalizeFieldOfficerPermissions,
  profileClaimsFieldOfficerRole,
  touchFieldOfficerLastLogin,
  type FieldOfficerPermissions,
} from "@/lib/field-officer-auth";

interface AuthDebugUser {
  id: number | null;
  email: string;
  userType: string;
  emailVerified: boolean | null;
  phoneVerified: boolean | null;
  verificationStatus: string;
  accountStatus: string;
  effectiveIdentityVerified?: boolean;
  effectiveIdentityReason?: string;
}

export interface NgoAuthResult {
  allowed: boolean;
  reason: string;
  /** Authenticated user id (officer id for Field Officers; NGO/individual id otherwise). */
  userId?: number;
  /** Display name for the authenticated user. */
  name?: string;
  ngoId?: number;
  ngoName?: string;
  email?: string;
  role?: string;
  avatarUrl?: string | null;
  identityId?: string;
  mustChangePassword?: boolean;
  permissions?: FieldOfficerPermissions;
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

// The platform only stores bcrypt hashes; anything else must not authenticate.
async function comparePassword(inputPassword: string, storedPassword: string) {
  const passwordFormat = detectPasswordFormat(storedPassword);
  return {
    passwordFormat,
    passwordMatched:
      passwordFormat === "bcrypt" && (await bcrypt.compare(inputPassword, storedPassword)),
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
      "id, name, email, password, user_type, email_verified, phone_verified, verification_status, account_status, locked_until, device_id, profile_image, profile_data"
    )
    .ilike("email", normalizedEmail)
    .maybeSingle();

  debug.userLookupError = userError?.message;

  if (userError || !userRow) {
    return {
      allowed: false,
      reason: userError ? "Sign-in is temporarily unavailable. Try again shortly." : "Invalid email or password.",
      debug,
    };
  }

  const userType = normalizeStatus(userRow.user_type);
  const verificationStatus = normalizeStatus(userRow.verification_status);

  debug.user = {
    id: typeof userRow.id === "number" ? userRow.id : null,
    email: typeof userRow.email === "string" ? userRow.email : normalizedEmail,
    userType,
    emailVerified: typeof userRow.email_verified === "boolean" ? userRow.email_verified : null,
    phoneVerified: typeof userRow.phone_verified === "boolean" ? userRow.phone_verified : null,
    verificationStatus,
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

  const blockReason = getAccountAccessBlockReason(userRow);
  if (blockReason) {
    return { allowed: false, reason: blockReason, debug: { ...debug, stage: "account-blocked" } };
  }

  if (!FIELD_APP_ROLES.has(userType)) {
    return {
      allowed: false,
      reason: "Only NGO and individual accounts can use the field app.",
      debug,
    };
  }

  const displayName =
    (typeof userRow.name === "string" && userRow.name.trim()) ||
    (typeof userRow.email === "string" ? userRow.email : normalizedEmail);
  const avatarUrl = resolveUserAvatarUrl({
    profileImage: userRow.profile_image,
    profileData: userRow.profile_data,
  });

  if (userType === "ngo") {
    debug.stage = "lookup-ngo-verification";
    const { data: ngoVerif, error: ngoVerifError } = await supabase
      .from("ngo_verifications")
      .select("ngo_name, verification_status")
      .eq("user_id", userRow.id)
      .maybeSingle();

    debug.ngoVerificationLookupError = ngoVerifError?.message;
    debug.ngoVerificationStatus = normalizeStatus(ngoVerif?.verification_status);

    if (ngoVerifError || !ngoVerif) {
      return {
        allowed: false,
        reason: ngoVerifError
          ? "Sign-in is temporarily unavailable. Try again shortly."
          : "Verification record not found. Complete your profile on the platform.",
        debug,
      };
    }

    const identityGatePassed =
      verificationStatus === "verified" || debug.ngoVerificationStatus === "verified";
    debug.identityGatePassed = identityGatePassed;
    debug.identityGateReason =
      verificationStatus === "verified"
        ? "users.verification_status is verified"
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
      userId: userRow.id as number,
      name: displayName,
      ngoId: userRow.id as number,
      role: "ngo",
      ngoName:
        (typeof ngoVerif?.ngo_name === "string" && ngoVerif.ngo_name.trim()) || displayName,
      email: typeof userRow.email === "string" ? userRow.email : normalizedEmail,
      avatarUrl,
      debug: { ...debug, stage: "authenticated" },
    };
  }

  // individual — Field Officers are individual users with a linked identity.
  debug.stage = "lookup-field-officer-identity";
  let fieldOfficerIdentity: Awaited<ReturnType<typeof findFieldOfficerIdentityByUserId>> = null;
  try {
    fieldOfficerIdentity = await findFieldOfficerIdentityByUserId(userRow.id as number);
  } catch (error) {
    console.error("[ngo-auth] field officer identity lookup failed:", error);
    return {
      allowed: false,
      reason: "Sign-in is temporarily unavailable. Try again shortly.",
      debug: { ...debug, stage: "field-officer-lookup-error" },
    };
  }

  const claimsFieldOfficer = profileClaimsFieldOfficerRole(userRow.profile_data);
  if (fieldOfficerIdentity || claimsFieldOfficer) {
    if (!fieldOfficerIdentity || fieldOfficerIdentity.status !== "active") {
      return {
        allowed: false,
        // Same generic denial whether identity is missing or inactive — avoid enumeration.
        reason: "This account cannot sign in.",
        debug: { ...debug, stage: "field-officer-inactive" },
      };
    }

    if (!Number.isFinite(fieldOfficerIdentity.ngo_user_id) || fieldOfficerIdentity.ngo_user_id <= 0) {
      return {
        allowed: false,
        reason: "This account cannot sign in.",
        debug: { ...debug, stage: "field-officer-malformed" },
      };
    }

    await touchFieldOfficerLastLogin(fieldOfficerIdentity.id);

    let ngoName = displayName;
    const { data: parentNgo } = await supabase
      .from("users")
      .select("name")
      .eq("id", fieldOfficerIdentity.ngo_user_id)
      .maybeSingle();
    if (typeof parentNgo?.name === "string" && parentNgo.name.trim()) {
      ngoName = parentNgo.name.trim();
    }

    return {
      allowed: true,
      reason: "OK",
      userId: userRow.id as number,
      name: displayName,
      // Parent NGO from DB identity only — never from client input.
      ngoId: fieldOfficerIdentity.ngo_user_id,
      ngoName,
      email: typeof userRow.email === "string" ? userRow.email : normalizedEmail,
      role: "field_officer",
      avatarUrl,
      identityId: fieldOfficerIdentity.id,
      mustChangePassword: fieldOfficerIdentity.must_change_password,
      permissions: normalizeFieldOfficerPermissions(fieldOfficerIdentity.permissions),
      debug: { ...debug, stage: "authenticated-field-officer" },
    };
  }

  debug.stage = "lookup-individual";
  const { data: indVerif, error: indVerifError } = await supabase
    .from("individual_verifications")
    .select("verification_status")
    .eq("user_id", userRow.id)
    .maybeSingle();

  debug.individualVerificationStatus =
    normalizeStatus(indVerif?.verification_status) || verificationStatus || undefined;

  if (indVerifError) {
    return {
      allowed: false,
      reason: "Sign-in is temporarily unavailable. Try again shortly.",
      debug: { ...debug, stage: "individual-verification-error" },
    };
  }

  const individualVerificationStatus = normalizeStatus(indVerif?.verification_status);
  if (individualVerificationStatus !== "verified" || verificationStatus !== "verified") {
    return {
      allowed: false,
      reason: `Verification is ${individualVerificationStatus || verificationStatus || "incomplete"}. Fully verified accounts can access the field app.`,
      debug: { ...debug, stage: "individual-not-verified" },
    };
  }

  return {
    allowed: true,
    reason: "OK",
    userId: userRow.id as number,
    name: displayName,
    ngoId: userRow.id as number,
    role: "individual",
    ngoName: displayName,
    email: typeof userRow.email === "string" ? userRow.email : normalizedEmail,
    avatarUrl,
    debug: { ...debug, stage: "authenticated" },
  };
}
