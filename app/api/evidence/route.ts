import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { hasCloudinaryEnv, sanitizeCloudinarySegment, uploadBufferToCloudinary } from "@/lib/cloudinary";
import { findAccountBlockReason } from "@/lib/account-access";
import {
  evidenceImmutableHash,
  evidenceMediaType,
  isLockedMilestoneStatus,
  LOCKED_MILESTONE_STATUSES,
  priorMilestonesArePaidComplete,
  validateEvidenceFiles,
} from "@/lib/evidence-rules";
import {
  assertClientMediaProofs,
  assertExpectedPrevHash,
  calculateEvidenceChainHash,
  hashMediaBytes,
} from "@/lib/evidence-integrity";
import {
  fieldOfficerHasPermission,
  type FieldOfficerIdentityRow,
} from "@/lib/field-officer-auth";
import { assertFieldOfficerAssignedToProject } from "@/lib/field-officer-projects";
import { IngestionPayload, SyncApiResponse } from "@/lib/types";

export const runtime = "nodejs";

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

type EvidenceActor =
  | {
      role: "ngo";
      ngoUserId: number;
      uploadedBy: number;
      deviceIdFallback: string;
      source: "field_pwa";
      identity: null;
    }
  | {
      role: "field_officer";
      ngoUserId: number;
      uploadedBy: number;
      deviceIdFallback: string;
      source: "field_officer_pwa";
      identity: FieldOfficerIdentityRow;
    };

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return fail("Authentication required.", 401);
  }

  if (session.role !== "ngo" && session.role !== "field_officer") {
    return fail("Evidence capture is available for NGO and Field Officer accounts.", 403);
  }

  if (!hasCloudinaryEnv()) {
    return fail("Cloudinary configuration missing.", 500);
  }

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return fail("Payload missing.", 400);
    }
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

    // Never trust client-supplied ownership / officer identity fields.
    const supabase = getServerSupabaseClient();
    const clientDeviceId =
      request.headers.get("x-device-id") || String(data.deviceId || "").trim() || null;

    let actor: EvidenceActor | null = null;

    if (session.role === "ngo") {
      const ngoId = Number(session.ngoId);
      const blockReason = await findAccountBlockReason(ngoId);
      if (blockReason) return fail(blockReason, 403);
      actor = {
        role: "ngo",
        ngoUserId: ngoId,
        uploadedBy: ngoId,
        deviceIdFallback: String(data.deviceId || "unknown"),
        source: "field_pwa",
        identity: null,
      };
    }

    const { data: existingEvent, error: existingError } = await supabase
      .from("field_events")
      .select("id, payload_hash, ngo_id, entity_id")
      .eq("event_id", event_id)
      .maybeSingle();
    if (existingError) throw existingError;

    if (existingEvent && actor) {
      if (Number(existingEvent.ngo_id) !== actor.ngoUserId) {
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
    if (!project) {
      return fail(milestone ? "Milestone not found." : "Project not found.", 404);
    }

    if (session.role === "field_officer") {
      const access = await assertFieldOfficerAssignedToProject(session, projectId, {
        allowPasswordChangePending: false,
        clientDeviceId,
      });
      if (!access.ok) {
        return fail(access.error, access.status === 404 ? 404 : access.status);
      }
      if (!fieldOfficerHasPermission(access.identity.permissions, "can_submit_field_evidence")) {
        return fail("You do not have permission to submit field evidence.", 403);
      }
      if (Number(project.ngo_user_id) !== access.identity.ngo_user_id) {
        return fail("This project is not assigned to your account.", 403);
      }

      actor = {
        role: "field_officer",
        ngoUserId: access.identity.ngo_user_id,
        uploadedBy: access.identity.user_id,
        deviceIdFallback: access.deviceId || clientDeviceId || "unknown",
        source: "field_officer_pwa",
        identity: access.identity,
      };

      if (existingEvent) {
        if (Number(existingEvent.ngo_id) !== actor.ngoUserId) {
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
    } else if (actor) {
      if (Number(project.ngo_user_id) !== actor.ngoUserId) {
        return fail(milestone ? "Milestone not found." : "Project not found.", 404);
      }
    }

    if (!actor) {
      return fail("Evidence capture is available for NGO and Field Officer accounts.", 403);
    }

    if (milestone && isLockedMilestoneStatus(milestone.status)) {
      return fail("This milestone is already approved, so new evidence can't be added.", 422);
    }

    if (milestone) {
      const { data: siblings, error: siblingsError } = await supabase
        .from("csr_project_milestones")
        .select("id, status, milestone_order")
        .eq("project_id", projectId);
      if (siblingsError) throw siblingsError;
      if (!priorMilestonesArePaidComplete(siblings || [], milestone.id)) {
        return fail(
          "Previous milestone payment must be confirmed before evidence can be submitted for this milestone.",
          422
        );
      }
    }

    const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
    const fileError = validateEvidenceFiles(files);
    if (fileError) return fail(fileError, 413);

    const fileBuffers: Buffer[] = [];
    const mediaContentHashes: string[] = [];
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      fileBuffers.push(buffer);
      mediaContentHashes.push(hashMediaBytes(buffer));
    }

    const proofError = assertClientMediaProofs(data.mediaProofHashes ?? body.media_proof_hashes, mediaContentHashes);
    if (proofError) return fail(proofError, 400);

    const folderPath = `navadrishti/ngo-${actor.ngoUserId}/${milestone ? `milestone-${sanitizeCloudinarySegment(milestone.id)}` : `project-${sanitizeCloudinarySegment(String(project.id))}`}`;
    const cloudinaryAssets = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const buffer = fileBuffers[i];
      const upload = await uploadBufferToCloudinary(buffer, {
        folder: folderPath,
        resource_type: "auto",
      });

      cloudinaryAssets.push({
        url: upload.secure_url,
        asset_id: upload.asset_id,
        format: upload.format,
        bytes: upload.bytes,
        mime_type: file.type,
        file_name: file.name || null,
        content_sha256: mediaContentHashes[i],
      });
    }

    const capturedAt = validTimestamp(body.timestamp);
    const {
      uploaded_by: _ignoreUploadedBy,
      ngo_user_id: _ignoreNgoUserId,
      field_officer_identity_id: _ignoreFoIdentity,
      ...safeClientData
    } = data as Record<string, unknown>;

    const finalData = {
      ...safeClientData,
      media: cloudinaryAssets,
      media_content_hashes: mediaContentHashes,
      capturedAtServer: new Date().toISOString(),
      actor_role: actor.role,
      resolved_ngo_user_id: actor.ngoUserId,
      resolved_uploaded_by: actor.uploadedBy,
      field_officer_identity_id: actor.identity?.id ?? null,
    };

    const chainEntityId = milestone?.id || String(project.id);
    const { data: lastEvent, error: lastEventError } = await supabase
      .from("field_events")
      .select("id, payload_hash, timestamp")
      .eq("entity_id", chainEntityId)
      .order("timestamp", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastEventError) throw lastEventError;

    const prevHash = lastEvent?.payload_hash ?? null;

    const claimedPrev =
      (data as { expectedPrevHash?: unknown }).expectedPrevHash ??
      body.expected_prev_hash ??
      body.prev_hash;
    const prevMismatch = assertExpectedPrevHash(claimedPrev, prevHash);
    if (prevMismatch) return fail(prevMismatch, 409);

    const tipOccupancyBase = supabase
      .from("field_events")
      .select("id")
      .eq("entity_id", chainEntityId)
      .limit(1);
    const tipOccupancy =
      prevHash === null
        ? tipOccupancyBase.is("prev_hash", null)
        : tipOccupancyBase.eq("prev_hash", prevHash);
    const { data: occupyingChild, error: occupyError } = await tipOccupancy.maybeSingle();
    if (occupyError) throw occupyError;
    if (occupyingChild) {
      return fail("Evidence chain tip changed. Retry sync to append to the latest tip.", 409);
    }

    const authoritativeHash = calculateEvidenceChainHash({
      prevHash,
      sealedData: finalData,
      mediaContentHashes,
    });

    const resolvedDeviceId = String(
      actor.role === "field_officer" ? actor.deviceIdFallback : data.deviceId || actor.deviceIdFallback
    );

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
            uploaded_by: actor.uploadedBy,
            ngo_user_id: actor.ngoUserId,
            device_id: resolvedDeviceId || "unknown",
            description: typeof data.notes === "string" && data.notes.trim() ? data.notes.trim() : null,
            gps_lat: finiteOrNull(data.gpsLat),
            gps_long: finiteOrNull(data.gpsLng),
            gps_accuracy_meters: finiteOrNull(data.gpsAccuracy),
            captured_at: capturedAt,
            evidence_summary: {
              source: actor.source,
              field_event_id: event_id,
              payload_hash: authoritativeHash,
              media_content_hashes: mediaContentHashes,
              beneficiary_name: data.beneficiaryName || null,
              interaction_type: data.interactionType || null,
              reference_point_id: data.referencePointId || null,
              field_officer_identity_id: actor.identity?.id ?? null,
              field_officer_user_id: actor.role === "field_officer" ? actor.uploadedBy : null,
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
          event_payload: {
            milestone_id: milestone.id,
            project_id: project.id,
            uploaded_by: actor.uploadedBy,
            ngo_user_id: actor.ngoUserId,
            source: actor.source,
            field_officer_identity_id: actor.identity?.id ?? null,
          },
          created_by: actor.uploadedBy,
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
        ngo_id: actor.ngoUserId,
        device_id: resolvedDeviceId || "unknown",
        timestamp: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (insertError) {
      if ((insertError as { code?: string }).code === "23505") {
        const { data: raced, error: racedError } = await supabase
          .from("field_events")
          .select("id, payload_hash, ngo_id")
          .eq("event_id", event_id)
          .maybeSingle();
        if (racedError) throw racedError;
        if (raced && Number(raced.ngo_id) === actor.ngoUserId) {
          return NextResponse.json<SyncApiResponse>({
            ok: true,
            eventId: raced.id,
            payloadHash: raced.payload_hash,
          });
        }
        return fail("Evidence chain tip changed. Retry sync to append to the latest tip.", 409);
      }
      throw insertError;
    }

    return NextResponse.json<SyncApiResponse>({
      ok: true,
      eventId: inserted.id,
      payloadHash: authoritativeHash,
      media: cloudinaryAssets,
    });
  } catch (err) {
    console.error("[Sync API] Error:", err);
    return fail("Evidence could not be saved. It will retry automatically.", 500);
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: "Sync API is active." });
}
