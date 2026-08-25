import { createClient } from "@supabase/supabase-js";
import { getSupabaseServiceKey, getSupabaseUrl } from "@/lib/env";

export function getMissingServerSupabaseEnv() {
  const missing: string[] = [];

  if (!getSupabaseUrl()) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  }

  if (!getSupabaseServiceKey()) {
    missing.push("SUPABASE_SECRET_KEY");
  }

  return missing;
}

export function hasServerSupabaseEnv() {
  return getMissingServerSupabaseEnv().length === 0;
}

export function getServerSupabaseClient() {
  const supabaseUrl = getSupabaseUrl();
  const supabaseServiceRoleKey = getSupabaseServiceKey();

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "Server Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.",
    );
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
