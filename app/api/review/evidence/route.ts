import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session || session.role !== "ca") {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const milestoneId = searchParams.get("milestone_id");

  if (!milestoneId) {
    return NextResponse.json({ ok: false, error: "milestone_id is required." }, { status: 400 });
  }

  try {
    const supabase = getServerSupabaseClient();

    // Fetch the EVIDENCE_SUBMITTED event for this milestone
    const { data, error } = await supabase
      .from("events")
      .select("payload, timestamp, user_id")
      .eq("entity_id", milestoneId)
      .eq("event_type", "EVIDENCE_SUBMITTED")
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "No evidence found for this milestone." }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      evidence: {
        media: data.payload.media || [],
        notes: data.payload.notes || "",
        capturedAt: data.payload.capturedAtDevice || data.timestamp,
        submittedBy: data.user_id
      }
    });
  } catch (err) {
    console.error("[Evidence API] Error:", err);
    return NextResponse.json({ ok: false, error: "Internal server error." }, { status: 500 });
  }
}
