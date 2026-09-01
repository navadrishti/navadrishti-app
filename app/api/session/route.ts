import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getMissingServerEnv, getSessionSecret, hasServerEnv } from "@/lib/env";
import { getMissingServerSupabaseEnv, hasServerSupabaseEnv } from "@/lib/supabase-server";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { resolveUserAvatarUrl } from "@/lib/utils";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  const missingEnv = [...new Set([...getMissingServerSupabaseEnv(), ...getMissingServerEnv()])];

  let profile: { name: string; avatarUrl: string | null } | null = null;

  if (session) {
    const supabase = getServerSupabaseClient();
    const { data } = await supabase
      .from("users")
      .select("name, profile_image, profile_data")
      .eq("id", session.ngoId)
      .maybeSingle();

    if (data) {
      profile = {
        name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : session.name,
        avatarUrl: resolveUserAvatarUrl({
          profileImage: data.profile_image,
          profileData: data.profile_data,
        }),
      };
    }
  }

  return NextResponse.json({
    configured: hasServerEnv(),
    missingEnv,
    session,
    profile,
  });
}
