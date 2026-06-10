import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { hasCloudinaryEnv, uploadBufferToCloudinary } from "@/lib/cloudinary";
import { IngestionPayload, SyncApiResponse } from "@/lib/types";

export const runtime = "nodejs";

function calculateServerHash(payload: any, prevHash: string | null): string {
  const dataToHash = JSON.stringify({
    prev_hash: prevHash,
    data: payload
  });
  // Using native crypto with fallback for stability
  return crypto.createHash("sha256").update(dataToHash).digest("hex");
}

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return NextResponse.json<SyncApiResponse>(
      { ok: false, error: "Authentication required." },
      { status: 401 }
    );
  }

  if (!hasCloudinaryEnv()) {
    return NextResponse.json<SyncApiResponse>(
      { ok: false, error: "Cloudinary configuration missing." },
      { status: 500 }
    );
  }

  try {
    const formData = await request.formData();
    const payloadStr = formData.get("payload") as string;
    
    if (!payloadStr) {
      return NextResponse.json<SyncApiResponse>(
        { ok: false, error: "Payload missing." },
        { status: 400 }
      );
    }

    const body: IngestionPayload = JSON.parse(payloadStr);
    const { event_id, event_type, entity_id, data } = body;

    const supabase = getServerSupabaseClient();

    // 1. Idempotency Check
    const { data: existingEvent } = await supabase
      .from("events")
      .select("id, payload_hash")
      .eq("event_id", event_id)
      .maybeSingle();

    if (existingEvent) {
      return NextResponse.json<SyncApiResponse>({
        ok: true,
        eventId: existingEvent.id,
        payloadHash: existingEvent.payload_hash,
      });
    }

    // 2. Process Media
    const files = formData.getAll("files") as File[];
    const cloudinaryAssets = [];

    const isGov = session.role === "gov";
    const folderPath = isGov 
      ? `navadrishti/gov/site-${entity_id}`
      : `navadrishti/ngo-${session.ngoId}/milestone-${entity_id}`;

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const upload = await uploadBufferToCloudinary(buffer, {
        folder: folderPath,
        resource_type: "auto"
      });

      cloudinaryAssets.push({
        url: upload.secure_url,
        asset_id: upload.asset_id,
        format: upload.format,
        bytes: upload.bytes
      });
    }

    const finalData = {
      ...data,
      media: cloudinaryAssets,
      capturedAtServer: new Date().toISOString()
    };

    // 3. Chain & Hash
    const { data: lastEvent } = await supabase
      .from("events")
      .select("payload_hash")
      .eq("entity_id", entity_id)
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash = lastEvent?.payload_hash ?? null;
    const authoritativeHash = calculateServerHash(finalData, prevHash);

    // 4. Insert to Ledger
    const { data: inserted, error: insertError } = await supabase
      .from("events")
      .insert({
        event_id,
        event_type,
        entity_id,
        payload: finalData,
        payload_hash: authoritativeHash,
        prev_hash: prevHash,
        user_id: session.email,
        ngo_id: session.ngoId,
        device_id: data.deviceId || "unknown",
        timestamp: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // 5. Update Milestone Status
    await supabase
      .from("csr_project_milestones")
      .update({ status: "submitted", updated_at: new Date().toISOString() })
      .eq("id", entity_id);

    return NextResponse.json<SyncApiResponse>({
      ok: true,
      eventId: inserted.id,
      payloadHash: authoritativeHash,
      media: cloudinaryAssets
    });
  } catch (err) {
    console.error("[Sync API] Error:", err);
    return NextResponse.json<SyncApiResponse>(
      { ok: false, error: err instanceof Error ? err.message : "Internal error." },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "Sync API is active." });
}
