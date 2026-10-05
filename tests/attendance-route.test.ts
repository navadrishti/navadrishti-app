import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSupabaseFake } from "./supabase-fake";

const fake = createSupabaseFake();
const session = { id: "7", ngoId: 7, email: "volunteer@example.org", role: "ngo" as string };

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

const { POST } = await import("@/app/api/attendance/[assignmentId]/route");
const { getLocalDateString, resolveAttendanceDate, AttendanceError } = await import("@/lib/attendance");

const photoBytes = "selfie-bytes";
const photoHash = createHash("sha256").update(photoBytes).digest("hex");
const today = getLocalDateString();

const activeUser = { data: { account_status: "active", locked_until: null, profile_data: {} } };
const campaignAssignment = {
  id: "as-1",
  target_type: "campaign",
  target_id: "c-1",
  owner_user_id: 3,
  assignee_user_id: 7,
  status: "active",
  meta: { volunteer_capacity: 40 },
};
const campaign = {
  start_date: "2026-01-01",
  end_date: "2099-12-31",
  status: "active",
  lead_ngo_user_id: 9,
  impact_metrics: { volunteer_applications: [{ applicant_user_id: 7, capacity: 5 }] },
};

function attendanceRequest(fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("attendanceStatus", "present");
  form.append("locationLatitude", "19.1");
  form.append("locationLongitude", "72.8");
  form.append("photoProofs", JSON.stringify([{ proofHash: photoHash, capturedAt: "2026-09-29T09:00:00.000Z" }]));
  form.append("photos", new File([photoBytes], "selfie.jpg", { type: "image/jpeg" }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new NextRequest("http://field.test/api/attendance/as-1", {
    method: "POST",
    body: form,
    headers: { cookie: "navadrishti_session=valid" },
  });
}

const context = { params: Promise.resolve({ assignmentId: "as-1" }) };

beforeEach(() => {
  session.role = "ngo";
});

describe("attendance date from the device", () => {
  const reference = new Date("2026-09-29T12:00:00");

  it("defaults to the server date and keeps recent device dates", () => {
    expect(resolveAttendanceDate(null, reference)).toBe("2026-09-29");
    expect(resolveAttendanceDate("2026-09-25", reference)).toBe("2026-09-25");
    expect(resolveAttendanceDate("2026-09-30", reference)).toBe("2026-09-30");
  });

  it("uses the India date even when the server clock is in UTC", () => {
    expect(getLocalDateString(new Date("2026-09-29T19:00:00Z"))).toBe("2026-09-30");
    expect(getLocalDateString(new Date("2026-09-29T18:00:00Z"))).toBe("2026-09-29");
  });

  it("refuses malformed, future and week-old dates", () => {
    expect(() => resolveAttendanceDate("29-09-2026", reference)).toThrow(AttendanceError);
    expect(() => resolveAttendanceDate("2026-10-01", reference)).toThrow(/too old/);
    expect(() => resolveAttendanceDate("2026-09-21", reference)).toThrow(/too old/);
  });
});

describe("POST /api/attendance/[assignmentId]", () => {
  it("rejects a queued mark that is too old before touching the database", async () => {
    fake.reset({});
    const response = await POST(attendanceRequest({ attendanceDate: "2020-01-01" }), context);
    expect(response.status).toBe(422);
    expect(fake.queries).toHaveLength(0);
  });

  it("records the campaign volunteer at their committed headcount with nothing owed", async () => {
    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [
        { data: campaignAssignment },
        { data: { meta: { volunteer_capacity: 40, settlement_note: "added meanwhile" } } },
      ],
      "campaigns.select": [{ data: campaign }],
      "service_attendance_entries.select": [
        { data: null },
        { data: [{ attendance_date: today, attendance_status: "present", amount_due: 0 }] },
      ],
      "service_attendance_entries.insert": [{ data: { id: "att-1" } }],
    });

    const response = await POST(attendanceRequest({ attendanceDate: today }), context);
    expect(response.status).toBe(201);

    const [insert] = fake.find("service_attendance_entries", "insert");
    expect(insert.payload).toMatchObject({
      attendance_date: today,
      units: 5,
      amount_due: 0,
      payment_status: "waived",
    });

    const [update] = fake.find("service_engagement_assignments", "update");
    expect(update.payload).toMatchObject({
      meta: {
        settlement_note: "added meanwhile",
        attendance_summary: { days_attended: 1, last_attendance_at: today },
      },
    });
  });

  it("answers a concurrent duplicate insert with 409 so the device clears its outbox", async () => {
    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [{ data: campaignAssignment }],
      "campaigns.select": [{ data: campaign }],
      "service_attendance_entries.select": [{ data: null }],
      "service_attendance_entries.insert": [{ error: { code: "23505", message: "duplicate key" } }],
    });

    const response = await POST(attendanceRequest(), context);
    expect(response.status).toBe(409);
  });

  describe("daily service offer rentals", () => {
    const offerRental = {
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
    };

    it("lets the client mark the provider present for one billed day", async () => {
      fake.reset({
        "users.select": [activeUser],
        "service_engagement_assignments.select": [{ data: offerRental }, { data: { meta: {} } }],
        "service_attendance_entries.select": [
          { data: null },
          { data: [{ attendance_date: today, attendance_status: "present", amount_due: 800, payment_status: "pending" }] },
        ],
        "service_attendance_entries.insert": [{ data: { id: "att-2" } }],
      });

      const response = await POST(attendanceRequest({ attendanceDate: today, units: "5" }), context);
      expect(response.status).toBe(201);
      const [insert] = fake.find("service_attendance_entries", "insert");
      expect(insert.payload).toMatchObject({
        units: 1,
        amount_due: 800,
        payment_status: "pending",
        application_table: "service_clients",
        marked_by_user_id: 7,
        marked_for_user_id: 3,
      });
    });

    it("refuses the provider marking their own attendance", async () => {
      fake.reset({
        "users.select": [activeUser],
        "service_engagement_assignments.select": [{ data: { ...offerRental, owner_user_id: 7, assignee_user_id: 4 } }],
      });
      const response = await POST(attendanceRequest(), context);
      expect(response.status).toBe(403);
      expect(fake.find("service_attendance_entries", "insert")).toHaveLength(0);
    });

    it("does not bill CSR capability rentals through attendance", async () => {
      fake.reset({
        "users.select": [activeUser],
        "service_engagement_assignments.select": [{ data: { ...offerRental, meta: { flow: "csr_capability_rental" } } }],
      });
      const response = await POST(attendanceRequest(), context);
      expect(response.status).toBe(422);
    });
  });

  it("refuses marks on a closed campaign assignment", async () => {
    fake.reset({
      "users.select": [activeUser],
      "service_engagement_assignments.select": [{ data: { ...campaignAssignment, status: "completed" } }],
      "campaigns.select": [{ data: campaign }],
    });

    const response = await POST(attendanceRequest(), context);
    expect(response.status).toBe(422);
    expect(fake.find("service_attendance_entries", "insert")).toHaveLength(0);
  });
});
