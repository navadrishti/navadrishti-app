import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getMissingServerEnv, hasServerEnv } from "@/lib/env";
import { getMissingServerSupabaseEnv, getServerSupabaseClient } from "@/lib/supabase-server";
import { resolveUserAvatarUrl } from "@/lib/utils";
import {
  clearSessionCookie,
  evaluateFieldOfficerSession,
  setSessionCookie,
} from "@/lib/field-officer-auth";

export const runtime = "nodejs";

async function loadProfile(userId: number, fallbackName: string) {
  const supabase = getServerSupabaseClient();
  const { data } = await supabase
    .from("users")
    .select("name, profile_image, profile_data")
    .eq("id", userId)
    .maybeSingle();

  if (!data) return null;

  return {
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : fallbackName,
    avatarUrl: resolveUserAvatarUrl({
      profileImage: data.profile_image,
      profileData: data.profile_data,
    }),
  };
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  let session = verifySessionToken(token);
  const missingEnv = [...new Set([...getMissingServerSupabaseEnv(), ...getMissingServerEnv()])];

  if (!session) {
    return NextResponse.json({
      configured: hasServerEnv(),
      missingEnv,
      session: null,
      profile: null,
    });
  }

  if (session.role === "field_officer") {
    try {
      const evaluation = await evaluateFieldOfficerSession(session, {
        allowPasswordChangePending: true,
      });

      if (!evaluation.ok) {
        const response = NextResponse.json({
          configured: hasServerEnv(),
          missingEnv,
          session: null,
          profile: null,
          error: evaluation.error,
        });
        clearSessionCookie(response);
        return response;
      }

      session = evaluation.session;
      const profile = await loadProfile(Number(session.id), session.name);
      const clientDeviceId = request.headers.get("x-device-id");
      const response = NextResponse.json({
        configured: hasServerEnv(),
        missingEnv,
        session,
        profile,
        mustChangePassword: Boolean(session.mustChangePassword),
        device: {
          authorised: true,
          code: null,
          error: null,
          deviceId: clientDeviceId || session.deviceId || null,
          label: null,
          status: "unbound",
        },
      });
      setSessionCookie(response, session);
      return response;
    } catch (error) {
      console.error("[api/session] field officer revalidation failed:", error);
      const response = NextResponse.json({
        configured: hasServerEnv(),
        missingEnv,
        session: null,
        profile: null,
        error: "Sign-in is temporarily unavailable. Try again shortly.",
      });
      clearSessionCookie(response);
      return response;
    }
  }

  const profile = await loadProfile(Number(session.id), session.name);

  return NextResponse.json({
    configured: hasServerEnv(),
    missingEnv,
    session,
    profile,
  });
}
