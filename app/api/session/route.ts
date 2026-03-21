import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getMissingServerSupabaseEnv, hasServerSupabaseEnv } from "@/lib/supabase-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  const missingEnv = getMissingServerSupabaseEnv();

  if (!process.env.APP_SESSION_SECRET) {
    missingEnv.push("APP_SESSION_SECRET");
  }

  return NextResponse.json({
    configured: hasServerSupabaseEnv() && Boolean(process.env.APP_SESSION_SECRET),
    missingEnv,
    session,
  });
}