import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken, type AppSession } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { findAccountBlockReason } from "@/lib/account-access";

export const CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND = "campaign_volunteer";

export type AttendanceKind = "campaign_volunteer" | "skill_service" | "service_offer" | "csr_capability";
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

/**
 * Schema CHECK on service_engagement_assignments.status:
 * active | in_progress | completed | cancelled.
 * Only active/in_progress may be marked. Legacy history tokens are treated as history when reading.
 */
const ACTIVE_ASSIGNMENT_STATUSES = new Set(["active", "in_progress"]);
const HISTORY_ASSIGNMENT_STATUSES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "finished",
  "closed",
  "done",
  "expired",
]);

export function isActiveAssignmentStatus(status: unknown): boolean {
  return ACTIVE_ASSIGNMENT_STATUSES.has(String(status || "").toLowerCase());
}

export function isHistoryAssignmentStatus(status: unknown): boolean {
  return HISTORY_ASSIGNMENT_STATUSES.has(String(status || "").toLowerCase());
}

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
 * Field-worker / assignee path: an active campaign volunteer assignment grants
 * PWA campaign visibility without requiring impact_metrics.volunteer_applications.
 * Volunteer-apply flow remains separate (isCampaignVolunteerApplicant).
 */
export function isEligibleAssignedCampaignVolunteer(
  assignment: {
    assignee_user_id?: unknown;
    status?: unknown;
    target_type?: string;
    meta?: unknown;
  } | null | undefined,
  userId: number
): boolean {
  if (!assignment) return false;
  if (Number(assignment.assignee_user_id) !== Number(userId)) return false;
  if (!isActiveAssignmentStatus(assignment.status)) return false;
  if (!isCampaignVolunteerAssignment(assignment)) return false;

  const kind = String(safeJson(assignment.meta).engagement_kind || "").trim();
  if (kind && kind !== CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND) return false;
  if (assignment.target_type === "csr_project" && kind !== CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND) {
    return false;
  }
  return true;
}

/**
 * Daily-billed hired service offers. Completion stays on the Main delivery/payment workflow —
 * they are not listed or markable in GRAM PWA attendance.
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

/** Paid-upfront campaign capabilities — completed via platform rental/delivery, not PWA attendance. */
export function isCsrCapabilityRentalAssignment(
  assignment: { meta?: unknown } | null | undefined
): boolean {
  if (!assignment) return false;
  return safeJson(assignment.meta).flow === "csr_capability_rental";
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
  if (status === "cancelled" || status === "canceled" || status === "rejected") return "cancelled";
  if (status === "completed" || status === "finished" || status === "closed" || status === "done" || status === "ended") return "finished";
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

/** Aligns with Main `lib/service-request-allocation/fulfillment-mode.ts`. */
export function getNgoNeedFulfillmentMode(request: Record<string, any> | null | undefined): string {
  const type = String(request?.request_type || request?.category || "").toLowerCase();
  if (type.includes("financial") || type.includes("fund") || type.includes("money")) return "financial";
  if (type.includes("material") || type.includes("deliver")) return "material";
  if (type.includes("infrastructure") || type.includes("infra")) return "infrastructure";
  if (type.includes("skill") || type.includes("service")) return "skill_service";
  return "skill_service";
}

function attendanceBlockedForFulfillmentMode(mode: string): string | null {
  if (mode === "skill_service") return null;
  if (mode === "material") {
    return "Material supply is completed through delivery confirmation, not attendance";
  }
  if (mode === "infrastructure") {
    return "Infrastructure work is completed through the fulfilment lifecycle, not attendance";
  }
  if (mode === "financial") {
    return "Financial needs are completed through payment fulfilment, not attendance";
  }
  return "This service type does not use field attendance";
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
    .in("status", ["active", "in_progress", "completed", "cancelled"]);

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
  const campaignsById = new Map((campaigns || []).map((row) => [String(row.id), row]));

  const campaignAssignments = rows.filter((row) => isCampaignVolunteerAssignment(row));
  const assignmentsByCampaignId = new Map(
    campaignAssignments.map((row) => [resolveCampaignIdFromAssignment(row) || String(row.target_id), row])
  );

  const assignedCampaignRows = rows.filter((row) => isEligibleAssignedCampaignVolunteer(row, userId));
  const assignedCampaignIds = assignedCampaignRows
    .map((row) => resolveCampaignIdFromAssignment(row) || String(row.target_id || ""))
    .filter(Boolean);

  const companyIds = [
    ...new Set(
      [
        ...volunteered.map((row) => Number(row.company_id || 0)),
        ...assignedCampaignIds.map((id) => Number(campaignsById.get(String(id))?.company_id || 0)),
      ].filter((id) => id > 0)
    ),
  ];
  const { data: companies } =
    companyIds.length > 0
      ? await supabase.from("users").select("id, name, email").in("id", companyIds)
      : { data: [] as any[] };
  const companiesById = new Map((companies || []).map((row) => [Number(row.id), row]));

  const seenCampaignIds = new Set<string>();

  const pushCampaignAttendanceItem = (input: {
    campaign: (typeof volunteered)[number];
    assignment: (typeof rows)[number] | null | undefined;
    capacity: number;
  }) => {
    const campaignId = String(input.campaign.id);
    if (seenCampaignIds.has(campaignId)) return;
    if (isCampaignLeadNgo(input.campaign, userId)) return;

    const lifecycle = getCampaignLifecycle({
      startDate: input.campaign.start_date,
      endDate: input.campaign.end_date,
      campaignStatus: input.campaign.status,
    });
    const bucket = isHistoryLifecycle(lifecycle) ? history : active;
    const meta = safeJson(input.assignment?.meta);
    const company = companiesById.get(Number(input.campaign.company_id || 0));
    const assignmentActive = isActiveAssignmentStatus(input.assignment?.status);
    const markBlockedReason =
      lifecycle === "yet_to_start"
        ? "Opens when the campaign starts"
        : lifecycle !== "started"
          ? "Campaign has ended"
          : !input.assignment?.id
            ? "Attendance is not set up yet. Refresh in a moment."
            : !assignmentActive
              ? "Your volunteer assignment is no longer active"
              : null;

    seenCampaignIds.add(campaignId);
    bucket.campaignItems.push({
      kind: "campaign_volunteer" as const,
      assignment_id: input.assignment?.id || null,
      title: input.campaign.title || "CSR Campaign",
      subtitle: company?.name || "Company",
      location: input.campaign.location || null,
      lifecycle,
      campaign_status: input.campaign.status || "draft",
      start_date: input.campaign.start_date || null,
      end_date: input.campaign.end_date || null,
      volunteer_capacity: toNumber(input.capacity || meta.volunteer_capacity, 1) || 1,
      attendance_summary: meta.attendance_summary || {},
      can_mark: markBlockedReason === null,
      mark_blocked_reason: markBlockedReason,
      mark_mode: "self_location" as const,
      bucket: isHistoryLifecycle(lifecycle) ? ("history" as const) : ("active" as const),
    });
  };

  for (const campaign of volunteered) {
    const application = getVolunteerApplicationForUser(campaign.impact_metrics, userId);
    if (!application) continue;

    let assignment = assignmentsByCampaignId.get(String(campaign.id));

    // Only auto-create assignment rows for active/upcoming campaigns (volunteer-apply path).
    if (!assignment && !isHistoryLifecycle(
      getCampaignLifecycle({
        startDate: campaign.start_date,
        endDate: campaign.end_date,
        campaignStatus: campaign.status,
      })
    )) {
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

    pushCampaignAttendanceItem({
      campaign,
      assignment,
      capacity: toNumber(application.capacity, 1) || 1,
    });
  }

  // Assignment path: active field-worker assignees see the campaign without a volunteer application.
  for (const assignment of assignedCampaignRows) {
    const campaignId = resolveCampaignIdFromAssignment(assignment) || String(assignment.target_id || "");
    if (!campaignId || seenCampaignIds.has(campaignId)) continue;
    const campaign = campaignsById.get(campaignId);
    if (!campaign) continue;
    const meta = safeJson(assignment.meta);
    pushCampaignAttendanceItem({
      campaign,
      assignment,
      capacity: toNumber(meta.volunteer_capacity, 1) || 1,
    });
  }

  // Skill-based service: the provider (assignee) self-marks — NGO lead does not mark for them.
  const providerSkill = rows.filter((row) => {
    const table = String(row.application_table || "");
    const isApplicationTable =
      table === "service_request_applications" ||
      table === "service_volunteers" ||
      !table;
    return (
      Number(row.assignee_user_id) === Number(userId) &&
      row.target_type === "service_request" &&
      isApplicationTable &&
      !isCampaignVolunteerAssignment(row)
    );
  });

  const requestIds = [
    ...new Set(providerSkill.map((row) => Number(row.target_id || 0)).filter((id) => id > 0)),
  ];
  const ownerIds = [
    ...new Set(providerSkill.map((row) => Number(row.owner_user_id || 0)).filter((id) => id > 0)),
  ];

  const { data: requests } =
    requestIds.length > 0
      ? await supabase
          .from("service_requests")
          .select("id, title, request_type, category, status")
          .in("id", requestIds)
      : { data: [] as any[] };

  const { data: owners } =
    ownerIds.length > 0
      ? await supabase.from("users").select("id, name, email").in("id", ownerIds)
      : { data: [] as any[] };

  const requestsById = new Map((requests || []).map((row) => [Number(row.id), row]));
  const ownersById = new Map((owners || []).map((row) => [Number(row.id), row]));

  for (const assignment of providerSkill) {
    const request = requestsById.get(Number(assignment.target_id));
    if (!request) continue;
    if (getNgoNeedFulfillmentMode(request) !== "skill_service") continue;

    const status = String(assignment.status || "").toLowerCase();
    const isHistory =
      isHistoryAssignmentStatus(status) ||
      String(request.status || "").toLowerCase() === "fulfilled" ||
      isHistoryAssignmentStatus(request.status);
    const bucket = isHistory ? history : active;

    const meta = safeJson(assignment.meta);
    const owner = ownersById.get(Number(assignment.owner_user_id));
    const dailyRate = toNumber(
      assignment.rate_per_unit ?? meta.rate_per_unit ?? meta.daily_rate,
      0
    );
    const canMark = !isHistory && isActiveAssignmentStatus(status);

    bucket.skillItems.push({
      kind: "skill_service" as const,
      assignment_id: assignment.id,
      title: request.title || "Skill / service need",
      subtitle: owner?.name || "Requesting organisation",
      assignee_email: owner?.email || null,
      request_status: request.status || null,
      assignment_status: assignment.status || null,
      daily_rate: dailyRate,
      attendance_summary: meta.attendance_summary || {},
      can_mark: canMark,
      mark_blocked_reason: canMark ? null : "This assignment is no longer active",
      mark_mode: "self_location" as const,
      assignee_user_id: Number(assignment.assignee_user_id || 0) || null,
      bucket: isHistory ? ("history" as const) : ("active" as const),
    });
  }

  // Material, infrastructure, financial needs, hired service offers, and CSR capability
  // rentals do not appear here — completion follows their delivery/fulfilment workflows.

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

    if (!isActiveAssignmentStatus(assignment.status)) {
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
    // Skill providers self-mark; requesting NGO (owner) cannot mark on their behalf.
    // Material / infrastructure / financial use delivery fulfilment — not attendance.
    if (!isAssignee) {
      throw new AttendanceError("Only the assigned skill provider can mark attendance", 403);
    }
    const { data: request } = await supabase
      .from("service_requests")
      .select("id, request_type, category, status")
      .eq("id", assignment.target_id)
      .maybeSingle();
    const mode = getNgoNeedFulfillmentMode(request);
    const blocked = attendanceBlockedForFulfillmentMode(mode);
    if (blocked) throw new AttendanceError(blocked, 422);
    const status = String(assignment.status || "").toLowerCase();
    if (!isActiveAssignmentStatus(status)) {
      throw new AttendanceError("This assignment is closed", 422);
    }
  } else if (
    isDailyServiceOfferAssignment(assignment) ||
    isCsrCapabilityRentalAssignment(assignment) ||
    assignment.target_type === "service_offer"
  ) {
    throw new AttendanceError(
      "Service offers complete through the platform delivery workflow, not field attendance",
      422
    );
  } else {
    throw new AttendanceError("This assignment type cannot be marked from the field app", 422);
  }
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
        (assignment.target_type === "campaign" ? "campaigns" : "service_request_applications"),
      application_id: assignment.application_id ?? null,
      attendance_date: today,
      attendance_status: status,
      attendance_source: attendanceSource,
      marked_by_user_id: userId,
      marked_for_user_id: Number(assignment.assignee_user_id || userId),
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
