import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken, type AppSession } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { findAccountBlockReason } from "@/lib/account-access";

export const CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND = "campaign_volunteer";

export type AttendanceKind = "campaign_volunteer" | "skill_service" | "service_offer";
export type AttendanceBucket = "active" | "history";

export class AttendanceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AttendanceError";
  }
}

export function attendanceErrorStatus(error: unknown): number {
  if (error instanceof AttendanceError) return error.status;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("already been marked") || message.includes("cannot be edited")) return 409;
  if (
    message.includes("Location is required") ||
    message.includes("1 to 3") ||
    message.includes("integrity")
  ) {
    return 400;
  }
  return 500;
}

/** Offline marks sync late, so the device's date is trusted within this window of the server's. */
const ATTENDANCE_BACKDATE_DAYS = 7;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

/** Schema CHECK: active | in_progress | completed | cancelled (+ legacy values when reading). */
const ACTIVE_ASSIGNMENT_STATUSES = new Set(["active", "in_progress"]);
const HISTORY_ASSIGNMENT_STATUSES = new Set(["completed", "cancelled"]);

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

/** Attendance days follow India time; the server itself usually runs in UTC. */
const ATTENDANCE_TIME_ZONE = "Asia/Kolkata";

export function getLocalDateString(reference: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(reference);
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

/**
 * Daily-billed service offer rentals: the client (assignee) confirms the provider showed up and pays per day.
 * CSR capability rentals are paid upfront and are not billed through attendance.
 */
export function isDailyServiceOfferAssignment(assignment: {
  target_type?: string;
  payment_mode?: string | null;
  billing_cycle?: string | null;
  meta?: unknown;
} | null | undefined): boolean {
  if (!assignment || assignment.target_type !== "service_offer") return false;
  const meta = safeJson(assignment.meta);
  if (meta.flow === "csr_capability_rental") return false;
  const paymentMode = String(assignment.payment_mode || meta.payment_mode || "").toLowerCase();
  const billingCycle = String(assignment.billing_cycle || meta.billing_cycle || "").toLowerCase();
  return paymentMode === "daily_due" || billingCycle === "daily";
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

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The device records the day the mark was taken. The server's clock may be a timezone behind,
 * so one day ahead is allowed, and queued marks may arrive up to a week late.
 */
export function resolveAttendanceDate(deviceDate: string | null | undefined, reference: Date = new Date()): string {
  const serverToday = getLocalDateString(reference);
  if (!deviceDate) return serverToday;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deviceDate) || Number.isNaN(Date.parse(`${deviceDate}T00:00:00Z`))) {
    throw new AttendanceError("Attendance date is invalid", 400);
  }
  if (deviceDate > shiftDate(serverToday, 1) || deviceDate < shiftDate(serverToday, -ATTENDANCE_BACKDATE_DAYS)) {
    throw new AttendanceError("This attendance mark is too old to sync. Mark attendance again today.", 422);
  }
  return deviceDate;
}

function getCampaignLifecycle(input: {
  startDate?: string | null;
  endDate?: string | null;
  campaignStatus?: string | null;
  onDate?: string;
}): "yet_to_start" | "started" | "finished" | "cancelled" {
  const status = String(input.campaignStatus || "").toLowerCase();
  if (status === "cancelled" || status === "rejected") return "cancelled";
  if (status === "completed" || status === "finished" || status === "closed") return "finished";
  if (status === "draft") return "yet_to_start";

  const today = input.onDate || getLocalDateString();
  const start = input.startDate ? String(input.startDate).slice(0, 10) : null;
  const end = input.endDate ? String(input.endDate).slice(0, 10) : null;

  if (end && end < today) return "finished";
  if (start && start > today) return "yet_to_start";
  return "started";
}

function isHistoryLifecycle(lifecycle: string): boolean {
  return lifecycle === "finished" || lifecycle === "cancelled";
}

/** Applicant on application-like rows (DB: applicant_user_id; campaign JSON may still use user_id). */
function getApplicationApplicantUserId(row: Record<string, unknown> | null | undefined): number {
  if (!row) return 0;
  return Number(row.applicant_user_id ?? row.user_id ?? 0) || 0;
}

function getVolunteerApplicationForUser(impactMetrics: unknown, userId: number) {
  const impact = safeJson(impactMetrics);
  const applications = Array.isArray(impact.volunteer_applications)
    ? impact.volunteer_applications
    : [];
  return (
    applications.find((entry: any) => {
      const applicantId =
        getApplicationApplicantUserId(entry) || Number(entry?.user_id || 0) || 0;
      return applicantId === Number(userId);
    }) || null
  );
}

type CampaignLeadRef = {
  lead_ngo_user_id?: number | string | null;
  impact_metrics?: unknown;
};

/** Lead NGOs coordinate CSR campaigns; they do not self-mark volunteer attendance. */
function isCampaignLeadNgo(campaign: CampaignLeadRef | null | undefined, userId: number): boolean {
  const leadNgoId = Number(campaign?.lead_ngo_user_id || 0);
  return leadNgoId > 0 && leadNgoId === Number(userId);
}

function isCampaignVolunteerApplicant(campaign: CampaignLeadRef, userId: number): boolean {
  if (isCampaignLeadNgo(campaign, userId)) return false;
  return Boolean(getVolunteerApplicationForUser(campaign.impact_metrics, userId));
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
    ]);

  if (assignmentError) throw assignmentError;

  const rows = assignmentRows || [];
  const active = emptyBucket();
  const history = emptyBucket();

  const { data: campaigns } = await supabase
    .from("campaigns")
    .select(
      "id, title, description, category, location, status, start_date, end_date, impact_metrics, lead_ngo_user_id, company_id"
    )
    .order("created_at", { ascending: false });

  const volunteered = (campaigns || []).filter((campaign) =>
    isCampaignVolunteerApplicant(campaign, userId)
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
    if (isCampaignLeadNgo(campaign, userId)) continue;

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
      const { data: created, error: createError } = await supabase
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
      if (isUniqueViolation(createError)) {
        // Another request (a second tab or device) created it first.
        const { data: existing } = await supabase
          .from("service_engagement_assignments")
          .select("*")
          .eq("target_type", "campaign")
          .eq("target_id", String(campaign.id))
          .eq("assignee_user_id", userId)
          .maybeSingle();
        assignment = existing || undefined;
      } else {
        assignment = created || undefined;
      }
    }

    const meta = safeJson(assignment?.meta);
    const company = companiesById.get(Number(campaign.company_id || 0));
    const assignmentActive = ACTIVE_ASSIGNMENT_STATUSES.has(String(assignment?.status || "").toLowerCase());
    const markBlockedReason =
      lifecycle === "yet_to_start"
        ? "Opens when the campaign starts"
        : lifecycle !== "started"
          ? "Campaign has ended"
          : !assignment?.id
            ? "Attendance is not set up yet. Refresh in a moment."
            : !assignmentActive
              ? "Your volunteer assignment is no longer active"
              : null;

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
      can_mark: markBlockedReason === null,
      mark_blocked_reason: markBlockedReason,
      mark_mode: "self_location" as const,
      bucket: isHistoryLifecycle(lifecycle) ? ("history" as const) : ("active" as const),
    });
  }

  const ownedSkill = rows.filter((row) => {
    const table = String(row.application_table || "");
    // Canonical table after pass-2; accept legacy offline meta that still says service_volunteers.
    const isApplicationTable =
      table === "service_request_applications" ||
      table === "service_volunteers" ||
      !table;
    return (
      Number(row.owner_user_id) === Number(userId) &&
      row.target_type === "service_request" &&
      isApplicationTable &&
      !isCampaignVolunteerAssignment(row)
    );
  });

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
      mark_blocked_reason: canMark ? null : "This assignment is no longer active",
      mark_mode: "ngo_mark" as const,
      assignee_user_id: Number(assignment.assignee_user_id || 0) || null,
      bucket: isHistory ? ("history" as const) : ("active" as const),
    });
  }

  const hiredOffers = rows.filter(
    (row) => Number(row.assignee_user_id) === Number(userId) && isDailyServiceOfferAssignment(row)
  );
  if (hiredOffers.length > 0) {
    const offerIds = [...new Set(hiredOffers.map((row) => Number(row.target_id || 0)).filter((id) => id > 0))];
    const providerIds = [...new Set(hiredOffers.map((row) => Number(row.owner_user_id || 0)).filter((id) => id > 0))];
    const [{ data: offers }, { data: providers }] = await Promise.all([
      offerIds.length > 0
        ? supabase.from("service_offers").select("id, title").in("id", offerIds)
        : Promise.resolve({ data: [] as any[] }),
      providerIds.length > 0
        ? supabase.from("users").select("id, name, email").in("id", providerIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const offersById = new Map((offers || []).map((row) => [Number(row.id), row]));
    const providersById = new Map((providers || []).map((row) => [Number(row.id), row]));

    for (const assignment of hiredOffers) {
      const status = String(assignment.status || "").toLowerCase();
      const isHistory = HISTORY_ASSIGNMENT_STATUSES.has(status);
      const canMark = !isHistory && ACTIVE_ASSIGNMENT_STATUSES.has(status);
      const meta = safeJson(assignment.meta);
      const provider = providersById.get(Number(assignment.owner_user_id));
      const bucket = isHistory ? history : active;

      bucket.skillItems.push({
        kind: "service_offer" as const,
        assignment_id: assignment.id,
        title: offersById.get(Number(assignment.target_id))?.title || "Hired service",
        subtitle: provider?.name || "Service provider",
        assignee_email: provider?.email || null,
        request_status: null,
        assignment_status: assignment.status || null,
        daily_rate: toNumber(assignment.rate_per_unit ?? meta.rate_per_unit, 0),
        attendance_summary: meta.attendance_summary || {},
        can_mark: canMark,
        mark_blocked_reason: canMark ? null : "This engagement is no longer active",
        mark_mode: "client_mark" as const,
        assignee_user_id: Number(assignment.owner_user_id || 0) || null,
        bucket: isHistory ? ("history" as const) : ("active" as const),
      });
    }
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
  attendanceDate?: string | null;
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
  const today = resolveAttendanceDate(input.attendanceDate);

  const photos = input.photos || [];
  if (photos.length < 1 || photos.length > 3) {
    throw new AttendanceError("Attendance requires 1 to 3 sealed photos", 400);
  }
  if (input.locationLatitude == null || input.locationLongitude == null) {
    throw new AttendanceError("Location is required to mark attendance", 400);
  }

  const blockReason = await findAccountBlockReason(userId);
  if (blockReason) throw new AttendanceError(blockReason, 403);

  const { data: assignment, error } = await supabase
    .from("service_engagement_assignments")
    .select("*")
    .eq("id", input.assignmentId)
    .maybeSingle();

  if (error || !assignment) {
    throw new AttendanceError("Assignment not found", 404);
  }

  const isCampaign = isCampaignVolunteerAssignment(assignment);
  const isOwner = Number(assignment.owner_user_id) === userId;
  const isAssignee = Number(assignment.assignee_user_id) === userId;
  let campaignApplication: Record<string, any> | null = null;

  if (isCampaign) {
    if (!isAssignee) throw new AttendanceError("Only the assigned campaign volunteer can mark attendance", 403);

    const campaignId = resolveCampaignIdFromAssignment(assignment);
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("start_date, end_date, status, impact_metrics, lead_ngo_user_id")
      .eq("id", campaignId)
      .maybeSingle();

    if (isCampaignLeadNgo(campaign, userId)) {
      throw new AttendanceError("Lead NGOs do not mark volunteer attendance for themselves", 403);
    }

    if (!ACTIVE_ASSIGNMENT_STATUSES.has(String(assignment.status || "").toLowerCase())) {
      throw new AttendanceError("This campaign assignment is closed", 422);
    }

    const lifecycle = getCampaignLifecycle({
      startDate: campaign?.start_date as string | null,
      endDate: campaign?.end_date as string | null,
      campaignStatus: campaign?.status as string | null,
      onDate: today,
    });
    if (lifecycle === "yet_to_start") {
      throw new AttendanceError("Attendance opens when the campaign starts", 422);
    }
    if (lifecycle === "finished" || lifecycle === "cancelled") {
      throw new AttendanceError("This campaign is no longer active for attendance", 422);
    }
    campaignApplication = getVolunteerApplicationForUser(campaign?.impact_metrics, userId);
  } else if (assignment.target_type === "service_request") {
    if (!isOwner) throw new AttendanceError("Only the assignment owner can mark daily attendance", 403);
    const status = String(assignment.status || "").toLowerCase();
    if (!ACTIVE_ASSIGNMENT_STATUSES.has(status)) {
      throw new AttendanceError("This assignment is closed", 422);
    }
  } else if (isDailyServiceOfferAssignment(assignment)) {
    if (!isAssignee) throw new AttendanceError("Only the client who hired this service can mark daily attendance", 403);
    const status = String(assignment.status || "").toLowerCase();
    if (!ACTIVE_ASSIGNMENT_STATUSES.has(status)) {
      throw new AttendanceError("This engagement is closed", 422);
    }
  } else {
    throw new AttendanceError("This assignment type cannot be marked from the field app", 422);
  }
  const isServiceOffer = assignment.target_type === "service_offer";

  const { data: existing } = await supabase
    .from("service_attendance_entries")
    .select("id")
    .eq("assignment_id", assignment.id)
    .eq("attendance_date", today)
    .maybeSingle();

  if (existing) {
    throw new AttendanceError("Attendance for today has already been marked and cannot be edited", 409);
  }

  // Verify photo integrity hashes before upload
  const crypto = await import("node:crypto");
  for (const photo of photos) {
    const actual = crypto.createHash("sha256").update(photo.buffer).digest("hex");
    if (actual !== String(photo.proofHash || "").toLowerCase()) {
      throw new AttendanceError("Photo integrity check failed. Recapture and try again.", 400);
    }
  }

  const { hasCloudinaryEnv, uploadBufferToCloudinary, sanitizeCloudinarySegment } = await import(
    "@/lib/cloudinary"
  );
  if (!hasCloudinaryEnv()) {
    throw new AttendanceError("Photo storage is not configured", 500);
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

  // A volunteering NGO counts as the headcount it committed in its application, not its whole team.
  const campaignUnitCap = Math.max(
    1,
    toNumber(campaignApplication?.capacity ?? safeJson(assignment.meta).volunteer_capacity, 1) || 1
  );
  const requestedUnits = input.units != null && input.units > 0 ? input.units : null;
  // One assignee per skill or rental engagement, billed one day at a time.
  const units = isCampaign ? Math.min(requestedUnits ?? campaignUnitCap, campaignUnitCap) : 1;

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
      application_table:
        assignment.application_table ||
        (assignment.target_type === "campaign"
          ? "campaigns"
          : isServiceOffer
            ? "service_clients"
            : "service_request_applications"),
      application_id: assignment.application_id ?? null,
      attendance_date: today,
      attendance_status: status,
      attendance_source: attendanceSource,
      marked_by_user_id: userId,
      marked_for_user_id: Number((isServiceOffer ? assignment.owner_user_id : assignment.assignee_user_id) || userId),
      units,
      multiplier: 1,
      rate_per_unit: ratePerUnit || null,
      amount_due: amountDue,
      payment_status: amountDue > 0 ? "pending" : "waived",
      meta,
    })
    .select("*")
    .single();

  if (isUniqueViolation(insertError)) {
    throw new AttendanceError("Attendance for today has already been marked and cannot be edited", 409);
  }
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
    days_attended: list.filter((entry) => String(entry.attendance_status || "").toLowerCase() === "present").length,
    total_due: totalDue,
    paid_total: paidTotal,
    payment_progress: totalDue > 0 ? Math.round((paidTotal / totalDue) * 100) : 0,
    last_attendance_at: list.length ? list[0].attendance_date : null,
  };

  // Re-read meta: the photo uploads above can take seconds and the platform may have changed it meanwhile.
  const { data: latest } = await supabase
    .from("service_engagement_assignments")
    .select("meta")
    .eq("id", assignment.id)
    .maybeSingle();

  await supabase
    .from("service_engagement_assignments")
    .update({
      meta: {
        ...safeJson(latest?.meta ?? assignment.meta),
        attendance_summary: summary,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", assignment.id);

  return { attendance, summary, units, sealedProof, photoCount: uploadedPhotos.length };
}
