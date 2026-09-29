import { getServerSupabaseClient } from "@/lib/supabase-server";

// Mirrors getAccountAccessBlockReason in the platform (lib/auth/account-status.ts); keep both in sync.

type AccountAccessInput = {
  account_status?: unknown;
  locked_until?: unknown;
  profile_data?: unknown;
};

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function futureDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return !Number.isNaN(date.getTime()) && date.getTime() > Date.now() ? date : null;
}

export function getAccountAccessBlockReason(input: AccountAccessInput): string | null {
  const status = String(input.account_status || "").trim().toLowerCase();
  const moderation = asObject(asObject(input.profile_data).admin_moderation);

  if (status === "banned" || status === "deactivated" || moderation.permanently_banned === true) {
    return "This account has been permanently banned.";
  }

  const until = futureDate(input.locked_until) || futureDate(moderation.suspended_until);
  if (until) {
    return `This account is suspended until ${until.toISOString().slice(0, 10)}.`;
  }

  if (status === "suspended") {
    return "This account is currently suspended.";
  }

  return null;
}

/** Re-checks the platform account on every write so suspensions apply to existing field sessions. */
export async function findAccountBlockReason(userId: number): Promise<string | null> {
  const { data, error } = await getServerSupabaseClient()
    .from("users")
    .select("account_status, locked_until, profile_data")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return "Account not found.";
  return getAccountAccessBlockReason(data);
}
