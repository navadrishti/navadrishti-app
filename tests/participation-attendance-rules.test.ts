import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSupabaseFake } from "./supabase-fake";

const fake = createSupabaseFake();
const session = {
  id: "7",
  ngoId: 7,
  email: "actor@example.org",
  role: "ngo" as string,
};

vi.mock("@/lib/supabase-server", () => ({ getServerSupabaseClient: () => fake.client }));
vi.mock("@/lib/session", () => ({
  SESSION_COOKIE_NAME: "navadrishti_session",
  verifySessionToken: (token?: string) => (token ? session : null),
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  hasServerEnv: () => true,
}));
vi.mock("@/lib/cloudinary", () => ({
  hasCloudinaryEnv: () => true,
  sanitizeCloudinarySegment: (value: string) => value,
  uploadBufferToCloudinary: vi.fn(async () => ({
    secure_url: "https://res.cloudinary.com/demo/image/upload/selfie.jpg",
    asset_id: "asset-1",
    public_id: "selfie",
    format: "jpg",
    bytes: 4,
  })),
}));

const { POST: postAttendance } = await import("@/app/api/attendance/[assignmentId]/route");
const { POST: postEvidence } = await import("@/app/api/evidence/route");
const {
  CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND,
  getLocalDateString,
  listAttendanceAssignments,
} = await import("@/lib/attendance");

const photoBytes = "selfie-bytes";
const photoHash = createHash("sha256").update(photoBytes).digest("hex");
const today = getLocalDateString();
const activeUser = { data: { account_status: "active", locked_until: null, profile_data: {} } };

const context = { params: Promise.resolve({ assignmentId: "as-1" }) };

function attendanceRequest(fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("attendanceStatus", "present");
  form.append("locationLatitude", "19.1");
  form.append("locationLongitude", "72.8");
  form.append(
    "photoProofs",
    JSON.stringify([{ proofHash: photoHash, capturedAt: "2026-09-29T09:00:00.000Z" }])
  );
  form.append("photos", new File([photoBytes], "selfie.jpg", { type: "image/jpeg" }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new NextRequest("http://field.test/api/attendance/as-1", {
    method: "POST",
    body: form,
    headers: { cookie: "navadrishti_session=valid" },
  });
}

function evidenceRequest(opts: { token?: string | null } = {}) {
  const form = new FormData();
  form.append(
    "payload",
    JSON.stringify({
      event_id: "rec-rules-1",
      event_type: "evidence",
      data: {
        milestoneId: "m-1",
        projectId: "p-1",
        notes: "Org field visit",
        beneficiaryName: "Ravi",
        interactionType: "visit",
        deviceId: "dev-1",
        locationLatitude: 19.1,
        locationLongitude: 72.8,
        capturedAt: "2026-09-28T10:00:00.000Z",
        mediaProofHashes: [createHash("sha256").update("abcd").digest("hex")],
      },
    })
  );
  form.append("files", new File(["abcd"], "proof.jpg", { type: "image/jpeg" }));
  const headers = new Headers();
  if (opts.token !== null) headers.set("cookie", "navadrishti_session=valid");
  return new NextRequest("http://field.test/api/evidence", { method: "POST", body: form, headers });
}

beforeEach(() => {
  session.id = "7";
  session.ngoId = 7;
  session.role = "ngo";
  session.email = "actor@example.org";
});

describe("participation attendance rules", () => {
  it("1. refuses personal attendance when the actor is the campaign lead NGO", async () => {
    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [
        {
          data: {
            id: "as-1",
            target_type: "campaign",
            target_id: "c-1",
            owner_user_id: 3,
            assignee_user_id: 7,
            status: "active",
            meta: { engagement_kind: CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND, volunteer_capacity: 1 },
          },
        },
      ],
      "campaigns.select": [
        {
          data: {
            start_date: "2026-01-01",
            end_date: "2099-12-31",
            status: "active",
            lead_ngo_user_id: 7,
            impact_metrics: {},
          },
        },
      ],
    });

    const response = await postAttendance(attendanceRequest(), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/Lead NGOs do not mark/i),
    });
    expect(fake.find("service_attendance_entries", "insert")).toHaveLength(0);
  });

  it("2. lets an NGO field account submit organisation evidence for its own project", async () => {
    const milestone = { id: "m-1", project_id: "p-1", status: "pending", milestone_order: 1 }
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: null }, { data: null }, { data: null }],
      // First select: target milestone; second: sibling chain for paid-complete gate
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
      "csr_milestone_evidence.select": [{ data: null }],
      "csr_milestone_evidence.insert": [{ data: { id: "ev-1" } }],
      "field_events.insert": [{ data: { id: "fe-1" } }],
    });

    const response = await postEvidence(evidenceRequest());
    expect(response.status).toBe(200);
    const [evidenceInsert] = fake.find("csr_milestone_evidence", "insert");
    expect(evidenceInsert.payload).toMatchObject({
      ngo_user_id: 7,
      uploaded_by: 7,
      project_id: "p-1",
      milestone_id: "m-1",
    });
  });

  it("4–5. NGO volunteer applications keep declared headcount and mark once for that capacity", async () => {
    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [
        {
          data: {
            id: "as-1",
            target_type: "campaign",
            target_id: "c-1",
            owner_user_id: 3,
            assignee_user_id: 7,
            status: "active",
            meta: { volunteer_capacity: 8 },
          },
        },
        { data: { meta: { volunteer_capacity: 8 } } },
      ],
      "campaigns.select": [
        {
          data: {
            start_date: "2026-01-01",
            end_date: "2099-12-31",
            status: "active",
            lead_ngo_user_id: 9,
            impact_metrics: {
              volunteer_applications: [{ user_id: 7, user_type: "ngo", capacity: 8 }],
            },
          },
        },
      ],
      "service_attendance_entries.select": [
        { data: null },
        { data: [{ attendance_date: today, attendance_status: "present", amount_due: 0 }] },
      ],
      "service_attendance_entries.insert": [{ data: { id: "att-ngo" } }],
    });

    const response = await postAttendance(attendanceRequest({ attendanceDate: today }), context);
    expect(response.status).toBe(201);
    const [insert] = fake.find("service_attendance_entries", "insert");
    expect(insert.payload).toMatchObject({
      units: 8,
      marked_by_user_id: 7,
      marked_for_user_id: 7,
      amount_due: 0,
    });
  });

  it("6. lets an individual volunteer mark their own campaign attendance", async () => {
    session.role = "individual";
    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [
        {
          data: {
            id: "as-1",
            target_type: "campaign",
            target_id: "c-1",
            owner_user_id: 3,
            assignee_user_id: 7,
            status: "active",
            meta: { volunteer_capacity: 1 },
          },
        },
        { data: { meta: {} } },
      ],
      "campaigns.select": [
        {
          data: {
            start_date: "2026-01-01",
            end_date: "2099-12-31",
            status: "active",
            lead_ngo_user_id: 9,
            impact_metrics: {
              volunteer_applications: [{ user_id: 7, user_type: "individual", capacity: 1 }],
            },
          },
        },
      ],
      "service_attendance_entries.select": [
        { data: null },
        { data: [{ attendance_date: today, attendance_status: "present", amount_due: 0 }] },
      ],
      "service_attendance_entries.insert": [{ data: { id: "att-ind" } }],
    });

    const response = await postAttendance(attendanceRequest({ attendanceDate: today }), context);
    expect(response.status).toBe(201);
    expect(fake.find("service_attendance_entries", "insert")[0].payload).toMatchObject({
      units: 1,
      marked_by_user_id: 7,
      marked_for_user_id: 7,
    });
  });

  it("7. refuses marking attendance for another user's assignment", async () => {
    session.role = "individual";
    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [
        {
          data: {
            id: "as-1",
            target_type: "campaign",
            target_id: "c-1",
            owner_user_id: 3,
            assignee_user_id: 44,
            status: "active",
            meta: { volunteer_capacity: 1 },
          },
        },
      ],
      "campaigns.select": [
        {
          data: {
            start_date: "2026-01-01",
            end_date: "2099-12-31",
            status: "active",
            lead_ngo_user_id: 9,
            impact_metrics: {},
          },
        },
      ],
    });

    const response = await postAttendance(attendanceRequest(), context);
    expect(response.status).toBe(403);
    expect(fake.find("service_attendance_entries", "insert")).toHaveLength(0);
  });

  it("8. lists and accepts self-mark for assigned skill providers", async () => {
    fake.reset({
      "service_engagement_assignments.select": [
        {
          data: [
            {
              id: "as-skill",
              target_type: "service_request",
              target_id: 15,
              owner_user_id: 3,
              assignee_user_id: 7,
              status: "active",
              application_table: "service_request_applications",
              rate_per_unit: 500,
              meta: {},
            },
          ],
        },
      ],
      "campaigns.select": [{ data: [] }],
      "service_requests.select": [
        { data: [{ id: 15, title: "Teaching support", request_type: "skill", status: "in_progress" }] },
      ],
      "users.select": [{ data: [{ id: 3, name: "Need NGO", email: "need@ngo.org" }] }],
    });

    const listed = await listAttendanceAssignments(7);
    expect(listed.active.skillItems).toHaveLength(1);
    expect(listed.active.skillItems[0]).toMatchObject({
      kind: "skill_service",
      assignment_id: "as-skill",
      mark_mode: "self_location",
      can_mark: true,
      subtitle: "Need NGO",
    });

    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [
        {
          data: {
            id: "as-1",
            target_type: "service_request",
            target_id: 15,
            owner_user_id: 3,
            assignee_user_id: 7,
            status: "active",
            application_table: "service_request_applications",
            rate_per_unit: 500,
            meta: {},
          },
        },
        { data: { meta: {} } },
      ],
      "service_requests.select": [
        { data: { id: 15, request_type: "Skill / Service Need", category: "skill", status: "in_progress" } },
      ],
      "service_attendance_entries.select": [
        { data: null },
        {
          data: [
            {
              attendance_date: today,
              attendance_status: "present",
              amount_due: 500,
              payment_status: "pending",
            },
          ],
        },
      ],
      "service_attendance_entries.insert": [{ data: { id: "att-skill" } }],
    });

    const response = await postAttendance(attendanceRequest({ attendanceDate: today }), context);
    expect(response.status).toBe(201);
    expect(fake.find("service_attendance_entries", "insert")[0].payload).toMatchObject({
      marked_by_user_id: 7,
      marked_for_user_id: 7,
      units: 1,
      amount_due: 500,
    });
  });

  it("8b. refuses NGO owners / clients marking skill attendance for providers", async () => {
    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [
        {
          data: {
            id: "as-1",
            target_type: "service_request",
            target_id: 15,
            owner_user_id: 7,
            assignee_user_id: 44,
            status: "active",
            application_table: "service_request_applications",
            meta: {},
          },
        },
      ],
    });

    const response = await postAttendance(attendanceRequest(), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/skill provider/i),
    });
    expect(fake.find("service_attendance_entries", "insert")).toHaveLength(0);
  });

  it("9. refuses daily service-offer client attendance; delivery stays on the platform", async () => {
    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [
        {
          data: {
            id: "as-1",
            target_type: "service_offer",
            target_id: "15",
            owner_user_id: 3,
            assignee_user_id: 7,
            application_table: "service_clients",
            application_id: "40",
            status: "active",
            billing_cycle: "daily",
            payment_mode: "daily_due",
            rate_per_unit: 800,
            meta: {},
          },
        },
      ],
    });

    const response = await postAttendance(attendanceRequest({ attendanceDate: today }), context);
    expect(response.status).toBe(422);
    expect(fake.find("service_attendance_entries", "insert")).toHaveLength(0);
  });

  it("material and infrastructure assignments are not listed or markable as attendance", async () => {
    fake.reset({
      "service_engagement_assignments.select": [
        {
          data: [
            {
              id: "as-mat",
              target_type: "service_request",
              target_id: 21,
              owner_user_id: 3,
              assignee_user_id: 7,
              status: "active",
              application_table: "service_request_applications",
              meta: {},
            },
            {
              id: "as-infra",
              target_type: "service_request",
              target_id: 22,
              owner_user_id: 3,
              assignee_user_id: 7,
              status: "active",
              application_table: "service_request_applications",
              meta: {},
            },
            {
              id: "as-daily",
              target_type: "service_offer",
              target_id: 30,
              owner_user_id: 3,
              assignee_user_id: 7,
              status: "active",
              billing_cycle: "daily",
              payment_mode: "daily_due",
              meta: {},
            },
          ],
        },
      ],
      "campaigns.select": [{ data: [] }],
      "service_requests.select": [
        {
          data: [
            { id: 21, title: "Cement bags", request_type: "Material Need", status: "in_progress" },
            { id: 22, title: "Well build", request_type: "Infrastructure Project", status: "in_progress" },
          ],
        },
      ],
      "users.select": [{ data: [{ id: 3, name: "Need NGO", email: "need@ngo.org" }] }],
    });

    const listed = await listAttendanceAssignments(7);
    expect(listed.active.skillItems).toHaveLength(0);
    expect(listed.history.skillItems).toHaveLength(0);

    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [
        {
          data: {
            id: "as-1",
            target_type: "service_request",
            target_id: 21,
            owner_user_id: 3,
            assignee_user_id: 7,
            status: "active",
            application_table: "service_request_applications",
            meta: {},
          },
        },
      ],
      "service_requests.select": [{ data: { id: 21, request_type: "Material Need", status: "in_progress" } }],
    });
    expect((await postAttendance(attendanceRequest(), context)).status).toBe(422);

    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [
        {
          data: {
            id: "as-1",
            target_type: "service_request",
            target_id: 22,
            owner_user_id: 3,
            assignee_user_id: 7,
            status: "active",
            application_table: "service_request_applications",
            meta: {},
          },
        },
      ],
      "service_requests.select": [
        { data: { id: 22, request_type: "Infrastructure Project", status: "in_progress" } },
      ],
    });
    expect((await postAttendance(attendanceRequest(), context)).status).toBe(422);
  });

  it("10. blocks unauthorized evidence and attendance", async () => {
    session.role = "individual";
    fake.reset({});
    expect((await postEvidence(evidenceRequest())).status).toBe(403);

    session.role = "ngo";
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: null }],
      "csr_project_milestones.select": [{ data: { id: "m-1", project_id: "p-1", status: "open" } }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 99 } }],
    });
    expect((await postEvidence(evidenceRequest())).status).toBe(404);
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);

    fake.reset({});
    const unauthAttendance = new NextRequest("http://field.test/api/attendance/as-1", {
      method: "POST",
      body: (() => {
        const form = new FormData();
        form.append("attendanceStatus", "present");
        form.append("locationLatitude", "19.1");
        form.append("locationLongitude", "72.8");
        form.append(
          "photoProofs",
          JSON.stringify([{ proofHash: photoHash, capturedAt: "2026-09-29T09:00:00.000Z" }])
        );
        form.append("photos", new File([photoBytes], "selfie.jpg", { type: "image/jpeg" }));
        return form;
      })(),
    });
    expect((await postAttendance(unauthAttendance, context)).status).toBe(401);
  });

  it("11. does not list lead-NGO campaigns for attendance while keeping volunteer visibility", async () => {
    const campaignId = "11111111-1111-4111-8111-111111111101";
    fake.reset({
      "service_engagement_assignments.select": [
        {
          data: [
            {
              id: "as-lead",
              target_type: "campaign",
              target_id: campaignId,
              owner_user_id: 1,
              assignee_user_id: 7,
              status: "active",
              meta: { engagement_kind: CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND, volunteer_capacity: 1 },
            },
            {
              id: "as-vol",
              target_type: "campaign",
              target_id: "camp-vol",
              owner_user_id: 1,
              assignee_user_id: 7,
              status: "active",
              meta: { engagement_kind: CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND, volunteer_capacity: 3 },
            },
          ],
        },
      ],
      "campaigns.select": [
        {
          data: [
            {
              id: campaignId,
              title: "Lead CSR",
              location: "Pune",
              status: "active",
              start_date: "2026-01-01",
              end_date: "2099-12-31",
              lead_ngo_user_id: 7,
              company_id: 1,
              impact_metrics: {},
            },
            {
              id: "camp-vol",
              title: "Volunteer CSR",
              location: "Pune",
              status: "active",
              start_date: "2026-01-01",
              end_date: "2099-12-31",
              lead_ngo_user_id: 9,
              company_id: 1,
              impact_metrics: {
                volunteer_applications: [{ user_id: 7, user_type: "ngo", capacity: 3 }],
              },
            },
          ],
        },
      ],
      "users.select": [{ data: [{ id: 1, name: "Co", email: "co@test" }] }],
    });

    const result = await listAttendanceAssignments(7);
    expect(result.active.campaignItems.map((item: { title: string }) => item.title)).toEqual([
      "Volunteer CSR",
    ]);
    expect(result.active.campaignItems[0].volunteer_capacity).toBe(3);
  });
});
