import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { hasCloudinaryEnv, uploadBufferToCloudinary } from "@/lib/cloudinary";

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

  if (!session || session.role !== "ca") {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. CA role required." },
      { status: 403 }
    );
  }

  if (!hasCloudinaryEnv()) {
    return NextResponse.json(
      { ok: false, error: "Cloudinary not configured." },
      { status: 500 }
    );
  }

  try {
    const formData = await request.formData();
    const event_id = formData.get("event_id") as string;
    const milestone_id = formData.get("milestone_id") as string;
    const receiptFile = formData.get("receipt") as File | null;

    if (!event_id || !milestone_id || !receiptFile) {
      return NextResponse.json(
        { ok: false, error: "Missing event_id, milestone_id, or receipt file." },
        { status: 400 }
      );
    }

    const supabase = getServerSupabaseClient();

    // 1. Idempotency
    const { data: existingEvent } = await supabase
      .from("events")
      .select("id")
      .eq("event_id", event_id)
      .maybeSingle();

    if (existingEvent) {
      return NextResponse.json({ ok: true, status: "already_processed" });
    }

    // 2. Validate Milestone State
    const { data: milestone, error: milestoneError } = await supabase
      .from("csr_project_milestones")
      .select("status, project_id, ngo_user_id")
      .eq("id", milestone_id)
      .maybeSingle();

    if (milestoneError || !milestone) {
      return NextResponse.json({ ok: false, error: "Milestone not found." }, { status: 404 });
    }

    if (milestone.status !== "approved") {
      return NextResponse.json(
        { ok: false, error: `Invalid state: ${milestone.status}. Must be 'approved'.` },
        { status: 422 }
      );
    }

    // 3. Upload Receipt to Cloudinary
    const buffer = Buffer.from(await receiptFile.arrayBuffer());
    const upload = await uploadBufferToCloudinary(buffer, {
      folder: `navadrishti/audit/payments/milestone-${milestone_id}`,
      resource_type: "auto",
      tags: ["payment-receipt", `ca-${session.email}`]
    });

    // 4. Chain Event
    const { data: lastEvent } = await supabase
      .from("events")
      .select("payload_hash")
      .eq("entity_id", milestone_id)
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash = lastEvent?.payload_hash ?? null;
    const finalData = {
      action: "payment_complete",
      milestoneId: milestone_id,
      receiptUrl: upload.secure_url,
      receiptAssetId: upload.asset_id,
      completedAt: new Date().toISOString(),
      executor: session.email
    };

    const authoritativeHash = calculateServerHash(finalData, prevHash);

    // 5. Append to Ledger
    const { error: insertError } = await supabase
      .from("events")
      .insert({
        event_id,
        event_type: "PAYMENT_COMPLETED",
        entity_id: milestone_id,
        payload: finalData,
        payload_hash: authoritativeHash,
        prev_hash: prevHash,
        user_id: session.email,
        ngo_id: milestone.ngo_user_id || 0,
        device_id: "ca-portal-payment",
        timestamp: new Date().toISOString()
      });

    if (insertError) throw insertError;

    // 6. Update Projection to 'payment_initiated'
    await supabase
      .from("csr_project_milestones")
      .update({ 
        status: "payment_initiated", 
        payment_receipt_url: upload.secure_url,
        updated_at: new Date().toISOString() 
      })
      .eq("id", milestone_id);

    return NextResponse.json({
      ok: true,
      status: "payment_initiated",
      receiptUrl: upload.secure_url
    });

  } catch (err) {
    console.error("[Payment API] Failure:", err);
    return NextResponse.json({ ok: false, error: "Internal processing failure." }, { status: 500 });
  }
}
