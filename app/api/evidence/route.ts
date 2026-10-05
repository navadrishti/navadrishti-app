import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { hasCloudinaryEnv, sanitizeCloudinarySegment, uploadBufferToCloudinary } from "@/lib/cloudinary";
import { findAccountBlockReason } from "@/lib/account-access";
import {
  evidenceImmutableHash,
  evidenceMediaType,
  isLockedMilestoneStatus,
  LOCKED_MILESTONE_STATUSES,
  validateEvidenceFiles,
} from "@/lib/evidence-rules";
import { IngestionPayload, SyncApiResponse } from "@/lib/types";

export const runtime = "nodejs";

function calculateServerHash(payload: any, prevHash: string | null): string {
  const dataToHash = JSON.stringify({
    prev_hash: prevHash,
    data: payload
  });
  return crypto.createHash("sha256").update(dataToHash).digest("hex");
}

function fail(error: string, status: number) {
  return NextResponse.json<SyncApiResponse>({ ok: false, error }, { status });
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validTimestamp(value: unknown): string {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return fail("Authentication required.", 401);
  }

  if (session.role !== "ngo") {
    return fail("Evidence capture is available for NGO accounts.", 403);
  }

  if (!hasCloudinaryEnv()) {
    return fail("Cloudinary configuration missing.", 500);
  }

  try {
    const ngoId = Number(session.ngoId);
    const blockReason = await findAccountBlockReason(ngoId);
    if (blockReason) return fail(blockReason, 403);

    const formData = await request.formData();
    const payloadStr = formData.get("payload");
    if (typeof payloadStr !== "string" || !payloadStr) {
      return fail("Payload missing.", 400);
    }

    let body: IngestionPayload;
    try {
      body = JSON.parse(payloadStr);
    } catch {
      return fail("Payload is not valid JSON.", 400);
    }

    const { event_id, event_type } = body;
    const data = body.data && typeof body.data === "object" ? body.data : {};
    if (!event_id || typeof event_id !== "string") {
      return fail("event_id is required.", 400);
    }

    const supabase = getServerSupabaseClient();

    const { data: existingEvent, error: existingError } = await supabase
      .from("field_events")
      .select("id, payload_hash, ngo_id, entity_id")
      .eq("event_id", event_id)
      .maybeSingle();
    if (existingError) throw existingError;

    if (existingEvent) {
      if (Number(existingEvent.ngo_id) !== ngoId) {
        return fail("Evidence event already exists.", 409);
      }
      const requestedEntityId = String(data.milestoneId || data.projectId || "").trim();
      if (requestedEntityId && String(existingEvent.entity_id) !== requestedEntityId) {
        return fail("Evidence event conflicts with an existing submission.", 409);
      }
      return NextResponse.json<SyncApiResponse>({
        ok: true,
        eventId: existingEvent.id,
        payloadHash: existingEvent.payload_hash,
      });
    }

    const milestoneId = String(data.milestoneId || "").trim();
    const requestedProjectId = String(data.projectId || "").trim();

    let milestone: { id: string; project_id: string; status: string | null } | null = null;
    let projectId = requestedProjectId;

    if (milestoneId) {
      const { data: row, error } = await supabase
        .from("csr_project_milestones")
        .select("id, project_id, status")
        .eq("id", milestoneId)
        .maybeSingle();
      if (error) throw error;
      if (!row) return fail("Milestone not found.", 404);
      milestone = row;
      projectId = row.project_id;
    }

    if (!projectId) {
      return fail("Choose a project or milestone for this evidence.", 400);
    }

    const { data: project, error: projectError } = await supabase
      .from("csr_projects")
      .select("id, ngo_user_id")
      .eq("id", projectId)
      .maybeSingle();
    if (projectError) throw projectError;
    if (!project || Number(project.ngo_user_id) !== ngoId) {
      return fail(milestone ? "Milestone not found." : "Project not found.", 404);
    }

    if (milestone && isLockedMilestoneStatus(milestone.status)) {
      return fail("This milestone is already approved, so new evidence can't be added.", 422);
    }

    const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
    const fileError = validateEvidenceFiles(files);
    if (fileError) return fail(fileError, 413);

    const folderPath = `navadrishti/ngo-${ngoId}/${milestone ? `milestone-${sanitizeCloudinarySegment(milestone.id)}` : `project-${sanitizeCloudinarySegment(String(project.id))}`}`;
    const cloudinaryAssets = [];
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
        bytes: upload.bytes,
        mime_type: file.type,
        file_name: file.name || null,
      });
    }

    const capturedAt = validTimestamp(body.timestamp);
    const finalData = {
      ...data,
      media: cloudinaryAssets,
      capturedAtServer: new Date().toISOString()
    };

    const chainEntityId = milestone?.id || String(project.id);
    const { data: lastEvent, error: lastEventError } = await supabase
      .from("field_events")
      .select("payload_hash")
      .eq("entity_id", chainEntityId)
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastEventError) throw lastEventError;

    const prevHash = lastEvent?.payload_hash ?? null;
    const authoritativeHash = calculateServerHash(finalData, prevHash);

    if (milestone) {
      const immutableHash = evidenceImmutableHash(event_id);
      const { data: existingEvidence, error: existingEvidenceError } = await supabase
        .from("csr_milestone_evidence")
        .select("id")
        .eq("immutable_hash", immutableHash)
        .maybeSingle();
      if (existingEvidenceError) throw existingEvidenceError;

      if (!existingEvidence) {
        const { data: evidence, error: evidenceError } = await supabase
          .from("csr_milestone_evidence")
          .insert({
            milestone_id: milestone.id,
            project_id: project.id,
            uploaded_by: ngoId,
            ngo_user_id: ngoId,
            device_id: String(data.deviceId || "unknown"),
            description: typeof data.notes === "string" && data.notes.trim() ? data.notes.trim() : null,
            gps_lat: finiteOrNull(data.gpsLat),
            gps_long: finiteOrNull(data.gpsLng),
            gps_accuracy_meters: finiteOrNull(data.gpsAccuracy),
            captured_at: capturedAt,
            evidence_summary: {
              source: "field_pwa",
              field_event_id: event_id,
              payload_hash: authoritativeHash,
              beneficiary_name: data.beneficiaryName || null,
              interaction_type: data.interactionType || null,
              reference_point_id: data.referencePointId || null,
            },
            submission_status: "submitted",
            immutable_hash: immutableHash,
          })
          .select("id")
          .single();
        if (evidenceError) throw evidenceError;

        const mediaRows = cloudinaryAssets.map((asset) => ({
          evidence_id: evidence.id,
          media_type: evidenceMediaType(asset.mime_type) || "image",
          media_url: asset.url,
          mime_type: asset.mime_type || null,
          file_name: asset.file_name,
          file_size_bytes: asset.bytes ?? null,
          captured_at: capturedAt,
        }));
        if (mediaRows.length > 0) {
          const { error: mediaError } = await supabase.from("csr_milestone_evidence_media").insert(mediaRows);
          if (mediaError) throw mediaError;
        }

        const { error: auditError } = await supabase.from("csr_audit_log").insert({
          entity_type: "evidence",
          entity_id: evidence.id,
          event_type: "milestone_evidence_submitted",
          event_hash: `evidence_submitted:${evidence.id}:${Date.now()}`,
          event_payload: { milestone_id: milestone.id, project_id: project.id, uploaded_by: ngoId, source: "field_pwa" },
          created_by: ngoId,
        });
        if (auditError) console.error("[api/evidence] audit log insert failed:", auditError);
      }

      const { error: statusError } = await supabase
        .from("csr_project_milestones")
        .update({ status: "submitted", updated_at: new Date().toISOString() })
        .eq("id", milestone.id)
        .not("status", "in", `(${LOCKED_MILESTONE_STATUSES.join(",")})`);
      if (statusError) throw statusError;
    }

    const { data: inserted, error: insertError } = await supabase
      .from("field_events")
      .insert({
        event_id,
        event_type,
        entity_id: chainEntityId,
        payload: finalData,
        payload_hash: authoritativeHash,
        prev_hash: prevHash,
        user_id: session.email,
        ngo_id: ngoId,
        device_id: String(data.deviceId || "unknown"),
        timestamp: new Date().toISOString()
      })
      .select("id")
      .single();

    if (insertError) {
      if ((insertError as { code?: string }).code === "23505") {
        return NextResponse.json<SyncApiResponse>({ ok: true, payloadHash: authoritativeHash });
      }
      throw insertError;
    }

    return NextResponse.json<SyncApiResponse>({
      ok: true,
      eventId: inserted.id,
      payloadHash: authoritativeHash,
      media: cloudinaryAssets
    });
  } catch (err) {
    console.error("[Sync API] Error:", err);
    return fail("Evidence could not be saved. It will retry automatically.", 500);
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "Sync API is active." });
}
