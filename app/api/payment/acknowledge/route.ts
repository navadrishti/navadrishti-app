import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

function calculateServerHash(payload: any, prevHash: string | null): string {
  const dataToHash = JSON.stringify({
    prev_hash: prevHash,
    data: payload
  });
  return crypto.createHash("sha256").update(dataToHash).digest("hex");
}

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session || session.role !== "ngo") {
    return NextResponse.json({ ok: false, error: "NGO role required." }, { status: 403 });
  }

  try {
    const { event_id, milestone_id } = await request.json();

    if (!event_id || !milestone_id) {
      return NextResponse.json({ ok: false, error: "Missing fields." }, { status: 400 });
    }

    const supabase = getServerSupabaseClient();

    // 1. Idempotency
    const { data: existingEvent } = await supabase
      .from("events")
      .select("id")
      .eq("event_id", event_id)
      .maybeSingle();

    if (existingEvent) return NextResponse.json({ ok: true });

    // 2. Validate State
    const { data: milestone, error: milestoneError } = await supabase
      .from("csr_project_milestones")
      .select("status, project_id, milestone_order, ngo_user_id")
      .eq("id", milestone_id)
      .maybeSingle();

    if (milestoneError || !milestone) {
      return NextResponse.json({ ok: false, error: "Milestone not found." }, { status: 404 });
    }

    if (milestone.ngo_user_id !== session.ngoId) {
      return NextResponse.json({ ok: false, error: "Unauthorized access to this milestone." }, { status: 403 });
    }

    if (milestone.status !== "payment_initiated") {
      return NextResponse.json({ ok: false, error: `Invalid state: ${milestone.status}. Must be 'payment_initiated'.` }, { status: 422 });
    }

    // 3. Ledger Entry
    const { data: lastEvent } = await supabase
      .from("events")
      .select("payload_hash")
      .eq("entity_id", milestone_id)
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash = lastEvent?.payload_hash ?? null;
    const finalData = {
      action: "payment_acknowledged",
      milestoneId: milestone_id,
      acknowledgedAt: new Date().toISOString(),
      user: session.email
    };

    const authoritativeHash = calculateServerHash(finalData, prevHash);

    const { error: insertError } = await supabase
      .from("events")
      .insert({
        event_id,
        event_type: "PAYMENT_ACKNOWLEDGED",
        entity_id: milestone_id,
        payload: finalData,
        payload_hash: authoritativeHash,
        prev_hash: prevHash,
        user_id: session.email,
        ngo_id: session.ngoId,
        device_id: "ngo-dashboard",
        timestamp: new Date().toISOString()
      });

    if (insertError) throw insertError;

    // 4. Update Current to 'paid'
    await supabase
      .from("csr_project_milestones")
      .update({ status: "paid", updated_at: new Date().toISOString() })
      .eq("id", milestone_id);

    // 5. Unlock Next Milestone
    const { data: nextMilestone } = await supabase
      .from("csr_project_milestones")
      .select("id")
      .eq("project_id", milestone.project_id)
      .gt("milestone_order", milestone.milestone_order)
      .order("milestone_order", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (nextMilestone) {
      await supabase
        .from("csr_project_milestones")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", nextMilestone.id);
    }

    return NextResponse.json({ ok: true, status: "paid" });

  } catch (err) {
    console.error("[Acknowledgment API] Failure:", err);
    return NextResponse.json({ ok: false, error: "Internal failure." }, { status: 500 });
  }
}
