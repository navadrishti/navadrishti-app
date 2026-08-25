import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken, type AppSession } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";

export const CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND = "campaign_volunteer";

export type AttendanceKind = "campaign_volunteer" | "skill_service";
export type AttendanceBucket = "active" | "history";

/** Schema CHECK: active | in_progress | completed | cancelled (+ legacy values when reading). */
const ACTIVE_ASSIGNMENT_STATUSES = new Set(["active", "in_progress", "assigned", "accepted"]);
const HISTORY_ASSIGNMENT_STATUSES = new Set(["completed", "cancelled", "rejected", "expired"]);

export function getSessionFromRequest(request: NextRequest): AppSession | null {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token);
}

export function safeJson(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function getLocalDateString(reference: Date = new Date()): string {
  const year = reference.getFullYear();
  const month = String(reference.getMonth() + 1).padStart(2, "0");
  const day = String(reference.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isCampaignVolunteerAssignment(assignment: {
  target_type?: string;
  meta?: unknown;
} | null | undefined): boolean {
  if (!assignment) return false;
  if (assignment.target_type === "campaign") return true;
  const meta = safeJson(assignment.meta);
  return (
    assignment.target_type === "csr_project" &&
    meta.engagement_kind === CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND
  );
}

export function resolveCampaignIdFromAssignment(assignment: {
  target_type?: string;
  target_id?: string | number | null;
  meta?: unknown;
}): string {
  if (assignment.target_type === "campaign") return String(assignment.target_id || "");
  const meta = safeJson(assignment.meta);
  return String(meta.campaign_id || assignment.target_id || "");
}

function isCampaignStarted(startDate: string | null | undefined): boolean {
  if (!startDate) return true;
  const start = new Date(String(startDate).slice(0, 10) + "T00:00:00");
  if (Number.isNaN(start.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return start.getTime() <= today.getTime();
}

function getCampaignLifecycle(input: {
  startDate?: string | null;
  endDate?: string | null;
  campaignStatus?: string | null;
}): "yet_to_start" | "started" | "finished" | "cancelled" {
  const status = String(input.campaignStatus || "").toLowerCase();
  if (status === "cancelled" || status === "rejected") return "cancelled";
  if (status === "completed" || status === "finished") return "finished";

  const today = getLocalDateString();
  const start = input.startDate ? String(input.startDate).slice(0, 10) : null;
  const end = input.endDate ? String(input.endDate).slice(0, 10) : null;

  if (end && end < today) return "finished";
  if (start && start > today) return "yet_to_start";
  return "started";
}

function isHistoryLifecycle(lifecycle: string): boolean {
  return lifecycle === "finished" || lifecycle === "cancelled";
}

function getVolunteerApplicationForUser(impactMetrics: unknown, userId: number) {
  const impact = safeJson(impactMetrics);
  const applications = Array.isArray(impact.volunteer_applications)
    ? impact.volunteer_applications
    : [];
  return (
    applications.find((entry: any) => Number(entry?.user_id || 0) === Number(userId)) || null
  );
}

function getNgoNeedFulfillmentMode(request: Record<string, any> | null | undefined): string {
  const type = String(request?.request_type || request?.category || "").toLowerCase();
  if (type.includes("material") || type.includes("deliver")) return "material";
  if (type.includes("financial") || type.includes("fund") || type.includes("money")) return "financial";
  if (type.includes("infrastructure") || type.includes("infra")) return "infrastructure";
  if (type.includes("skill") || type.includes("service")) return "skill_service";
  return "skill_service";
}

function emptyBucket() {
  return { campaignItems: [] as any[], skillItems: [] as any[] };
}

export async function listAttendanceAssignments(userId: number) {
  const supabase = getServerSupabaseClient();

  const { data: assignmentRows, error: assignmentError } = await supabase
    .from("service_engagement_assignments")
    .select("*")
    .or(`assignee_user_id.eq.${userId},owner_user_id.eq.${userId}`)
    .in("status", [
      "active",
      "in_progress",
      "completed",
      "cancelled",
      "assigned",
      "accepted",
    ]);

  if (assignmentError) throw assignmentError;

  const rows = assignmentRows || [];
  const active = emptyBucket();
  const history = emptyBucket();

  const { data: campaigns } = await supabase
    .from("campaigns")
    .select(
      "id, title, description, category, location, status, start_date, end_date, impact_metrics, company_id"
    )
    .order("created_at", { ascending: false });

  const volunteered = (campaigns || []).filter((campaign) =>
    Boolean(getVolunteerApplicationForUser(campaign.impact_metrics, userId))
  );

  const companyIds = [
    ...new Set(volunteered.map((row) => Number(row.company_id || 0)).filter((id) => id > 0)),
  ];
  const { data: companies } =
    companyIds.length > 0
      ? await supabase.from("users").select("id, name, email").in("id", companyIds)
      : { data: [] as any[] };
  const companiesById = new Map((companies || []).map((row) => [Number(row.id), row]));

  const campaignAssignments = rows.filter((row) => isCampaignVolunteerAssignment(row));
  const assignmentsByCampaignId = new Map(
    campaignAssignments.map((row) => [resolveCampaignIdFromAssignment(row) || String(row.target_id), row])
  );

  for (const campaign of volunteered) {
    const application = getVolunteerApplicationForUser(campaign.impact_metrics, userId);
    if (!application) continue;

    const lifecycle = getCampaignLifecycle({
      startDate: campaign.start_date,
      endDate: campaign.end_date,
      campaignStatus: campaign.status,
    });
    const bucket = isHistoryLifecycle(lifecycle) ? history : active;

    let assignment = assignmentsByCampaignId.get(String(campaign.id));

    // Only auto-create assignment rows for active/upcoming campaigns
    if (!assignment && !isHistoryLifecycle(lifecycle)) {
      const ownerUserId = Number(campaign.company_id || 0) || userId;
      const capacity = toNumber(application.capacity, 1) || 1;
      const { data: created } = await supabase
        .from("service_engagement_assignments")
        .insert({
          target_type: "campaign",
          target_id: String(campaign.id),
          owner_user_id: ownerUserId,
          assignee_user_id: userId,
          assigned_by_user_id: userId,
          status: "active",
          billing_cycle: "daily",
          payment_mode: "postpaid",
          meta: {
            engagement_kind: CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND,
            campaign_id: String(campaign.id),
            campaign_title: campaign.title || "CSR Campaign",
            volunteer_capacity: capacity,
            volunteer_user_type: application.user_type || null,
            volunteer_applied_at: application.applied_at || new Date().toISOString(),
            attendance_mode: "location",
          },
        })
        .select("*")
        .single();
      assignment = created || undefined;
    }

    const meta = safeJson(assignment?.meta);
    const company = companiesById.get(Number(campaign.company_id || 0));

    bucket.campaignItems.push({
      kind: "campaign_volunteer" as const,
      assignment_id: assignment?.id || null,
      title: campaign.title || "CSR Campaign",
      subtitle: company?.name || "Company",
      location: campaign.location || null,
      lifecycle,
      campaign_status: campaign.status || "draft",
      start_date: campaign.start_date || null,
      end_date: campaign.end_date || null,
      volunteer_capacity: toNumber(application.capacity || meta.volunteer_capacity, 1) || 1,
      attendance_summary: meta.attendance_summary || {},
      can_mark: lifecycle === "started" && Boolean(assignment?.id),
      mark_mode: "self_location" as const,
      bucket: isHistoryLifecycle(lifecycle) ? ("history" as const) : ("active" as const),
    });
  }

  const ownedSkill = rows.filter(
    (row) =>
      Number(row.owner_user_id) === Number(userId) &&
      row.target_type === "service_request" &&
      String(row.application_table || "") === "service_volunteers" &&
      !isCampaignVolunteerAssignment(row)
  );

  const requestIds = [
    ...new Set(ownedSkill.map((row) => Number(row.target_id || 0)).filter((id) => id > 0)),
  ];
  const assigneeIds = [
    ...new Set(ownedSkill.map((row) => Number(row.assignee_user_id || 0)).filter((id) => id > 0)),
  ];

  const { data: requests } =
    requestIds.length > 0
      ? await supabase
          .from("service_requests")
          .select("id, title, request_type, category, status")
          .in("id", requestIds)
      : { data: [] as any[] };

  const { data: assignees } =
    assigneeIds.length > 0
      ? await supabase.from("users").select("id, name, email").in("id", assigneeIds)
      : { data: [] as any[] };

  const requestsById = new Map((requests || []).map((row) => [Number(row.id), row]));
  const assigneesById = new Map((assignees || []).map((row) => [Number(row.id), row]));

  for (const assignment of ownedSkill) {
    const request = requestsById.get(Number(assignment.target_id));
    if (!request) continue;
    if (getNgoNeedFulfillmentMode(request) !== "skill_service") continue;

    const status = String(assignment.status || "").toLowerCase();
    const isHistory =
      HISTORY_ASSIGNMENT_STATUSES.has(status) ||
      String(request.status || "").toLowerCase() === "fulfilled" ||
      String(request.status || "").toLowerCase() === "completed" ||
      String(request.status || "").toLowerCase() === "closed";
    const bucket = isHistory ? history : active;

    const meta = safeJson(assignment.meta);
    const assignee = assigneesById.get(Number(assignment.assignee_user_id));
    const dailyRate = toNumber(
      assignment.rate_per_unit ?? meta.rate_per_unit ?? meta.daily_rate,
      0
    );
    const canMark = !isHistory && ACTIVE_ASSIGNMENT_STATUSES.has(status);

    bucket.skillItems.push({
      kind: "skill_service" as const,
      assignment_id: assignment.id,
      title: request.title || "Skill / service need",
      subtitle: assignee?.name || "Assignee",
      assignee_email: assignee?.email || null,
      request_status: request.status || null,
      assignment_status: assignment.status || null,
      daily_rate: dailyRate,
      attendance_summary: meta.attendance_summary || {},
      can_mark: canMark,
      mark_mode: "ngo_mark" as const,
      assignee_user_id: Number(assignment.assignee_user_id || 0) || null,
      bucket: isHistory ? ("history" as const) : ("active" as const),
    });
  }

  return {
    active,
    history,
    // Back-compat for older clients
    campaignItems: active.campaignItems,
    skillItems: active.skillItems,
  };
}

export async function markAttendance(input: {
  session: AppSession;
  assignmentId: string;
  attendanceStatus?: string;
  locationLatitude?: number | null;
  locationLongitude?: number | null;
  locationAccuracy?: number | null;
  units?: number | null;
  photos?: Array<{
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    proofHash: string;
    capturedAt: string;
  }>;
}) {
  const supabase = getServerSupabaseClient();
  const userId = Number(input.session.ngoId || input.session.id);
  const today = getLocalDateString();

  const photos = input.photos || [];
  if (photos.length < 1 || photos.length > 3) {
    throw new Error("Attendance requires 1 to 3 sealed photos");
  }
  if (input.locationLatitude == null || input.locationLongitude == null) {
    throw new Error("Location is required to mark attendance");
  }

  const { data: assignment, error } = await supabase
    .from("service_engagement_assignments")
    .select("*")
    .eq("id", input.assignmentId)
    .maybeSingle();

  if (error || !assignment) {
    throw new Error("Assignment not found");
  }

  const isCampaign = isCampaignVolunteerAssignment(assignment);
  const isOwner = Number(assignment.owner_user_id) === userId;
  const isAssignee = Number(assignment.assignee_user_id) === userId;

  if (isCampaign) {
    if (!isAssignee) throw new Error("Only the assigned campaign volunteer can mark attendance");

    const campaignId = resolveCampaignIdFromAssignment(assignment);
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("start_date, end_date, status")
      .eq("id", campaignId)
      .maybeSingle();

    const lifecycle = getCampaignLifecycle({
      startDate: campaign?.start_date as string | null,
      endDate: campaign?.end_date as string | null,
      campaignStatus: campaign?.status as string | null,
    });
    if (lifecycle === "yet_to_start" || !isCampaignStarted(campaign?.start_date as string | null)) {
      throw new Error("Attendance opens when the campaign starts");
    }
    if (lifecycle === "finished" || lifecycle === "cancelled") {
      throw new Error("This campaign is no longer active for attendance");
    }
  } else if (assignment.target_type === "service_request") {
    if (!isOwner) throw new Error("Only the assignment owner can mark daily attendance");
    const status = String(assignment.status || "").toLowerCase();
    if (!ACTIVE_ASSIGNMENT_STATUSES.has(status)) {
      throw new Error("This assignment is closed");
    }
  } else {
    throw new Error("This assignment type cannot be marked from the field app");
  }

  const { data: existing } = await supabase
    .from("service_attendance_entries")
    .select("id")
    .eq("assignment_id", assignment.id)
    .eq("attendance_date", today)
    .maybeSingle();

  if (existing) {
    throw new Error("Attendance for today has already been marked and cannot be edited");
  }

  // Verify photo integrity hashes before upload
  const crypto = await import("node:crypto");
  for (const photo of photos) {
    const actual = crypto.createHash("sha256").update(photo.buffer).digest("hex");
    if (actual !== String(photo.proofHash || "").toLowerCase()) {
      throw new Error("Photo integrity check failed. Recapture and try again.");
    }
  }

  const { hasCloudinaryEnv, uploadBufferToCloudinary, sanitizeCloudinarySegment } = await import(
    "@/lib/cloudinary"
  );
  if (!hasCloudinaryEnv()) {
    throw new Error("Photo storage is not configured");
  }

  const folder = `navadrishti/attendance/${sanitizeCloudinarySegment(String(assignment.id))}/${today}`;
  const uploadedPhotos = [];
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    const upload = await uploadBufferToCloudinary(photo.buffer, {
      folder,
      resource_type: "image",
      public_id: `shot-${i + 1}-${sanitizeCloudinarySegment(photo.proofHash.slice(0, 12))}`,
      overwrite: false,
    });
    uploadedPhotos.push({
      index: i + 1,
      url: upload.secure_url,
      asset_id: upload.asset_id,
      public_id: upload.public_id,
      bytes: upload.bytes,
      format: upload.format,
      proof_hash: photo.proofHash,
      captured_at: photo.capturedAt,
      file_name: photo.fileName,
      immutable: true,
    });
  }

  const sealedProof = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        assignment_id: assignment.id,
        attendance_date: today,
        latitude: input.locationLatitude,
        longitude: input.locationLongitude,
        photo_hashes: uploadedPhotos.map((p) => p.proof_hash),
      })
    )
    .digest("hex");

  const { data: actingUser } = await supabase
    .from("users")
    .select("id, ngo_volunteer_capacity, profile_data, user_type")
    .eq("id", userId)
    .maybeSingle();

  const profile = safeJson(actingUser?.profile_data);
  const ngoCapacity =
    toNumber(
      actingUser?.ngo_volunteer_capacity ??
        profile.ngo_volunteer_capacity ??
        profile.team_strength,
      0
    ) || 0;

  const units =
    input.units != null && input.units > 0
      ? input.units
      : isCampaign && String(actingUser?.user_type || input.session.role) === "ngo"
        ? Math.max(1, ngoCapacity || toNumber(safeJson(assignment.meta).volunteer_capacity, 1) || 1)
        : 1;

  const ratePerUnit = toNumber(assignment.rate_per_unit ?? safeJson(assignment.meta).rate_per_unit, 0);
  const status =
    String(input.attendanceStatus || "present").toLowerCase() === "absent" ? "absent" : "present";
  const amountDue =
    status === "present" && ratePerUnit > 0 ? Math.round(ratePerUnit * units * 100) / 100 : 0;

  const meta: Record<string, unknown> = {
    marked_via: "field_pwa",
    capture_mode: isCampaign ? "selfie" : "photo",
    units,
    immutable: true,
    sealed_at: new Date().toISOString(),
    sealed_proof: sealedProof,
    photo_count: uploadedPhotos.length,
    photos: uploadedPhotos,
    location: {
      latitude: input.locationLatitude,
      longitude: input.locationLongitude,
      accuracy: input.locationAccuracy ?? null,
      shared_at: new Date().toISOString(),
      attendance_date: today,
    },
  };

  // Schema CHECK: ngo_dashboard | company_ca_pwa | system
  const attendanceSource = "ngo_dashboard";

  const { data: attendance, error: insertError } = await supabase
    .from("service_attendance_entries")
    .insert({
      assignment_id: assignment.id,
      target_type: assignment.target_type,
      target_id: assignment.target_id,
      application_table: assignment.application_table,
      application_id: assignment.application_id,
      attendance_date: today,
      attendance_status: status,
      attendance_source: attendanceSource,
      marked_by_user_id: userId,
      marked_for_user_id: Number(assignment.assignee_user_id || userId),
      units,
      multiplier: 1,
      rate_per_unit: ratePerUnit || null,
      amount_due: amountDue,
      payment_status: "pending",
      meta,
    })
    .select("*")
    .single();

  if (insertError) throw insertError;

  const { data: entries } = await supabase
    .from("service_attendance_entries")
    .select("*")
    .eq("assignment_id", assignment.id)
    .order("attendance_date", { ascending: false });

  const list = entries || [];
  const totalDue = list.reduce((sum, entry) => sum + toNumber(entry.amount_due), 0);
  const paidTotal = list
    .filter((entry) => entry.payment_status === "paid")
    .reduce((sum, entry) => sum + toNumber(entry.amount_due), 0);

  const summary = {
    total_entries: list.length,
    days_attended: list.length,
    total_due: totalDue,
    paid_total: paidTotal,
    payment_progress: totalDue > 0 ? Math.round((paidTotal / totalDue) * 100) : 0,
    last_attendance_at: list.length ? list[0].attendance_date : null,
  };

  await supabase
    .from("service_engagement_assignments")
    .update({
      meta: {
        ...safeJson(assignment.meta),
        attendance_summary: summary,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", assignment.id);

  return { attendance, summary, units, sealedProof, photoCount: uploadedPhotos.length };
}
