import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });
  }

  try {
    const supabase = getServerSupabaseClient();
    
    let query = supabase
      .from("events")
      .select("*")
      .eq("event_type", "EVIDENCE_SUBMITTED")
      .order("timestamp", { ascending: false });

    // Strict Data Isolation: Users only see history of what THEY submitted
    // This prevents NGO evidence from appearing in GOV officer's local ledger and vice-versa.
    query = query.eq("user_id", session.email);

    const { data, error } = await query.limit(50);

    if (error) throw error;

    return NextResponse.json({ ok: true, events: data || [] });
  } catch (err) {
    console.error("[History API] Error:", err);
    return NextResponse.json({ ok: false, error: "Failed to fetch history." }, { status: 500 });
  }
}
