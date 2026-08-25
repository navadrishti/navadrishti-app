import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getMissingServerEnv, getSessionSecret, hasServerEnv } from "@/lib/env";
import { getMissingServerSupabaseEnv, hasServerSupabaseEnv } from "@/lib/supabase-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  const missingEnv = [...new Set([...getMissingServerSupabaseEnv(), ...getMissingServerEnv()])];

  return NextResponse.json({
    configured: hasServerEnv(),
    missingEnv,
    session,
  });
}