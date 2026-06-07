import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { hasCloudinaryEnv, uploadBufferToCloudinary } from "@/lib/cloudinary";
import { IngestionPayload, SyncApiResponse, SystemEvent } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Authoritatively recomputes the SHA256 hash of the payload metadata.
 */
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

  if (!session) {
    return NextResponse.json<SyncApiResponse>(
      { ok: false, error: "Authentication required for ingestion." },
      { status: 401 }
    );
  }

  if (!hasCloudinaryEnv()) {
    return NextResponse.json<SyncApiResponse>(
      { ok: false, error: "Cloudinary configuration missing on the server." },
      { status: 500 }
    );
  }

  try {
    const formData = await request.formData();
    const payloadStr = formData.get("payload") as string;
    
    if (!payloadStr) {
      return NextResponse.json<SyncApiResponse>(
        { ok: false, error: "Sync payload metadata is required." },
        { status: 400 }
      );
    }

    const body: IngestionPayload = JSON.parse(payloadStr);
    const { event_id, event_type, entity_id, data } = body;

    if (!event_id || !event_type || !entity_id || !data) {
      return NextResponse.json<SyncApiResponse>(
        { ok: false, error: "Invalid sync payload metadata schema." },
        { status: 400 }
      );
    }

    const supabase = getServerSupabaseClient();

    // 0. Zero-Trust Hardware Verification (Warning only for pilot)
    if (session.role === 'ngo') {
      const { data: userRecord } = await supabase
        .from("users")
        .select("device_id")
        .eq("id", session.ngoId)
        .single();
      
      if (!userRecord || (userRecord.device_id && userRecord.device_id !== session.deviceId)) {
        console.warn(`[ZERO_TRUST_WARNING] Hardware signature mismatch for user ${session.email}.`);
      }
    }

    // 1. Idempotency Check
    const { data: existingEvent } = await supabase
      .from("events")
      .select("id, payload_hash")
      .eq("event_id", event_id)
      .maybeSingle();

    if (existingEvent) {
      return NextResponse.json<SyncApiResponse>(
        {
          ok: true,
          eventId: existingEvent.id,
          payloadHash: existingEvent.payload_hash,
        },
        { status: 200 } // Return 200 to allow client to finish state transition
      );
    }

    // 2. Projection-Based Validation
    const { data: milestone, error: milestoneError } = await supabase
      .from("csr_project_milestones")
      .select("status, ngo_user_id, project_id")
      .eq("id", entity_id)
      .maybeSingle();

    if (milestoneError || !milestone) {
      return NextResponse.json<SyncApiResponse>(
        { ok: false, error: "Milestone projection not found or unauthorized." },
        { status: 404 }
      );
    }

    // 3. Process Media
    const files = formData.getAll("files") as File[];
    const cloudinaryAssets = [];

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const upload = await uploadBufferToCloudinary(buffer, {
        folder: `navadrishti/ngo-${session.ngoId}/project-${milestone.project_id}/milestone-${entity_id}`,
        resource_type: "auto",
        tags: ["field-evidence", `ngo-${session.ngoId}`],
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

    // 4. Atomic Chaining
    const { data: lastEvent } = await supabase
      .from("events")
      .select("payload_hash")
      .eq("entity_id", entity_id)
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash = lastEvent?.payload_hash ?? null;
    const authoritativeHash = calculateServerHash(finalData, prevHash);

    // 5. Append to Ledger
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

    // 6. Update Projection
    await supabase
      .from("csr_project_milestones")
      .update({ status: "submitted", updated_at: new Date().toISOString() })
      .eq("id", entity_id);

    return NextResponse.json<SyncApiResponse>({
      ok: true,
      eventId: inserted.id,
      payloadHash: authoritativeHash,
      media: cloudinaryAssets // Return the assets so client can update local remoteUrl
    });
  } catch (err) {
    console.error("[Ingestion API] Error:", err);
    return NextResponse.json<SyncApiResponse>(
      { ok: false, error: err instanceof Error ? err.message : "Internal ingestion failure." },
      { status: 500 }
    );
  }
}
