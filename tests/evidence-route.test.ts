import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSupabaseFake } from "./supabase-fake";

const fake = createSupabaseFake();
const session = { id: "7", ngoId: 7, email: "ngo@example.org", role: "ngo" as string };

vi.mock("@/lib/supabase-server", () => ({ getServerSupabaseClient: () => fake.client }));
vi.mock("@/lib/session", () => ({
  SESSION_COOKIE_NAME: "navadrishti_session",
  verifySessionToken: (token?: string) => (token ? session : null),
}));
vi.mock("@/lib/cloudinary", () => ({
  hasCloudinaryEnv: () => true,
  sanitizeCloudinarySegment: (value: string) => value,
  uploadBufferToCloudinary: vi.fn(async () => ({
    secure_url: "https://res.cloudinary.com/demo/image/upload/proof.jpg",
    asset_id: "asset-1",
    format: "jpg",
    bytes: 4,
  })),
}));

const { POST } = await import("@/app/api/evidence/route");

const activeUser = { data: { account_status: "active", locked_until: null, profile_data: {} } };
const milestone = { id: "m-1", project_id: "p-1", status: "pending" };

function evidenceRequest(options: { data?: Record<string, unknown>; files?: File[]; token?: string | null } = {}) {
  const form = new FormData();
  form.append(
    "payload",
    JSON.stringify({
      event_id: "rec-1",
      event_type: "EVIDENCE_SUBMITTED",
      entity_id: "m-1",
      timestamp: "2026-09-28T10:00:00.000Z",
      data: { milestoneId: "m-1", projectId: "p-1", deviceId: "dev-1", notes: "Visited site", gpsLat: 19.1, gpsLng: 72.8, ...options.data },
    })
  );
  for (const file of options.files ?? [new File(["abcd"], "proof.jpg", { type: "image/jpeg" })]) {
    form.append("files", file);
  }
  const headers: Record<string, string> = {};
  if (options.token !== null) headers.cookie = `navadrishti_session=${options.token ?? "valid"}`;
  return new NextRequest("http://field.test/api/evidence", { method: "POST", body: form, headers });
}

beforeEach(() => {
  session.role = "ngo";
});

describe("POST /api/evidence", () => {
  it("requires a session", async () => {
    fake.reset({});
    const response = await POST(evidenceRequest({ token: null }));
    expect(response.status).toBe(401);
  });

  it("writes the platform evidence row, media and milestone status so reviewers can see it", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: null }, { data: null }],
      "csr_project_milestones.select": [{ data: milestone }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
      "csr_milestone_evidence.select": [{ data: null }],
      "csr_milestone_evidence.insert": [{ data: { id: "ev-1" } }],
      "field_events.insert": [{ data: { id: "fe-1" } }],
    });

    const response = await POST(evidenceRequest());
    expect(response.status).toBe(200);

    const [evidenceInsert] = fake.find("csr_milestone_evidence", "insert");
    expect(evidenceInsert.payload).toMatchObject({
      milestone_id: "m-1",
      project_id: "p-1",
      uploaded_by: 7,
      ngo_user_id: 7,
      device_id: "dev-1",
      description: "Visited site",
      gps_lat: 19.1,
      gps_long: 72.8,
      captured_at: "2026-09-28T10:00:00.000Z",
      submission_status: "submitted",
      immutable_hash: "field_event:rec-1",
    });
    const [mediaInsert] = fake.find("csr_milestone_evidence_media", "insert");
    expect(mediaInsert.payload).toEqual([
      expect.objectContaining({ evidence_id: "ev-1", media_type: "image", mime_type: "image/jpeg", file_name: "proof.jpg" }),
    ]);
    const [statusUpdate] = fake.find("csr_project_milestones", "update");
    expect(statusUpdate.payload).toMatchObject({ status: "submitted" });
    expect(statusUpdate.filters).toContainEqual(["not", "status", "in", "(approved,completed)"]);
    expect(fake.find("field_events", "insert")[0].payload).toMatchObject({ event_id: "rec-1", entity_id: "m-1", ngo_id: 7 });
  });

  it("refuses evidence for another NGO's milestone without uploading anything", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: null }],
      "csr_project_milestones.select": [{ data: milestone }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 99 } }],
    });

    const response = await POST(evidenceRequest());
    expect(response.status).toBe(404);
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
    expect(fake.find("csr_project_milestones", "update")).toHaveLength(0);
  });

  it("refuses new evidence on an approved milestone", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: null }],
      "csr_project_milestones.select": [{ data: { ...milestone, status: "approved" } }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
    });

    const response = await POST(evidenceRequest());
    expect(response.status).toBe(422);
    expect(fake.find("csr_project_milestones", "update")).toHaveLength(0);
  });

  it("returns the recorded event on a retry instead of writing again", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: { id: "fe-1", payload_hash: "hash" } }],
    });

    const response = await POST(evidenceRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, eventId: "fe-1" });
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
  });

  it("reuses evidence written by an interrupted earlier attempt", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: null }, { data: null }],
      "csr_project_milestones.select": [{ data: milestone }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
      "csr_milestone_evidence.select": [{ data: { id: "ev-1" } }],
      "field_events.insert": [{ data: { id: "fe-1" } }],
    });

    const response = await POST(evidenceRequest());
    expect(response.status).toBe(200);
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
    expect(fake.find("field_events", "insert")).toHaveLength(1);
  });

  it("blocks suspended accounts that still hold a field session", async () => {
    fake.reset({ "users.select": [{ data: { account_status: "suspended", profile_data: {} } }] });
    const response = await POST(evidenceRequest());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "This account is currently suspended." });
  });

  it("rejects SVG uploads", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: null }],
      "csr_project_milestones.select": [{ data: milestone }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
    });
    const response = await POST(
      evidenceRequest({ files: [new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })] })
    );
    expect(response.status).toBe(413);
  });

  it("only lets NGO accounts submit evidence", async () => {
    session.role = "individual";
    fake.reset({});
    const response = await POST(evidenceRequest());
    expect(response.status).toBe(403);
  });
});
