import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { SystemEventType } from "@/lib/types";

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

  // 1. Validate Auth & Role
  if (!session || session.role !== "ca") {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. CA role required for milestone review." },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { event_id, milestone_id, action, remarks } = body;

    if (!event_id || !milestone_id || !["approve", "reject"].includes(action)) {
      return NextResponse.json(
        { ok: false, error: "Missing required fields: event_id, milestone_id, action (approve|reject)." },
        { status: 400 }
      );
    }

    const supabase = getServerSupabaseClient();

    // 2. Idempotency Check
    const { data: existingEvent } = await supabase
      .from("events")
      .select("id")
      .eq("event_id", event_id)
      .maybeSingle();

    if (existingEvent) {
      return NextResponse.json({ ok: true, status: "already_processed" }, { status: 200 });
    }

    // 3. Projection State Validation
    const { data: milestone, error: milestoneError } = await supabase
      .from("csr_project_milestones")
      .select("status, project_id")
      .eq("id", milestone_id)
      .maybeSingle();

    if (milestoneError || !milestone) {
      return NextResponse.json(
        { ok: false, error: "Milestone not found." },
        { status: 404 }
      );
    }

    if (milestone.status !== "submitted") {
      return NextResponse.json(
        { ok: false, error: `Invalid transition: Milestone is in '${milestone.status}' state. Expected 'submitted'.` },
        { status: 422 } // Unprocessable Entity
      );
    }

    // 4. Atomic Chaining
    const { data: lastEvent } = await supabase
      .from("events")
      .select("payload_hash")
      .eq("entity_id", milestone_id)
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash = lastEvent?.payload_hash ?? null;
    const eventType: SystemEventType = action === "approve" ? "MILESTONE_APPROVED" : "MILESTONE_REJECTED";
    
    const finalData = {
      action,
      remarks: remarks ?? "",
      reviewedAt: new Date().toISOString(),
      reviewer: session.email
    };

    const authoritativeHash = calculateServerHash(finalData, prevHash);

    // 5. Append to Ledger (Auditable)
    const { error: insertError } = await supabase
      .from("events")
      .insert({
        event_id,
        event_type: eventType,
        entity_id: milestone_id,
        payload: finalData,
        payload_hash: authoritativeHash,
        prev_hash: prevHash,
        user_id: session.email,
        ngo_id: 0, // CA is platform-wide/sponsor level
        device_id: "ca-portal",
        timestamp: new Date().toISOString()
      });

    if (insertError) throw insertError;

    // 6. Update Projection (UI Sync)
    // Per approval: "update csr_project_milestones via backend logic after event insertion to keep UI consistent"
    const nextStatus = action === "approve" ? "approved" : "rejected";
    const { error: updateError } = await supabase
      .from("csr_project_milestones")
      .update({ 
        status: nextStatus,
        updated_at: new Date().toISOString() 
      })
      .eq("id", milestone_id);

    if (updateError) throw updateError;

    return NextResponse.json({
      ok: true,
      status: nextStatus,
      payloadHash: authoritativeHash
    });

  } catch (err) {
    console.error("[Review API] Failure:", err);
    return NextResponse.json(
      { ok: false, error: "Internal review failure." },
      { status: 500 }
    );
  }
}
