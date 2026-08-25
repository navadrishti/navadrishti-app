import { createClient } from "@supabase/supabase-js";
import { getSupabasePublishableKey, getSupabaseUrl, hasBrowserSupabaseEnv } from "@/lib/env";

let cachedClient: ReturnType<typeof createClient> | null = null;

export function getSupabaseClient() {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabasePublishableKey();

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  if (!cachedClient) {
    cachedClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }

  return cachedClient;
}

export function hasSupabaseEnv() {
  return hasBrowserSupabaseEnv();
}

export { hasBrowserSupabaseEnv };
