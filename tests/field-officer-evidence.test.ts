import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { createSupabaseFake } from "./supabase-fake";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/session";
import { hashMediaBytes } from "@/lib/evidence-integrity";

const fake = createSupabaseFake();

vi.mock("@/lib/supabase-server", () => ({ getServerSupabaseClient: () => fake.client }));
vi.mock("@/lib/cloudinary", () => ({
  hasCloudinaryEnv: () => true,
  sanitizeCloudinarySegment: (value: string) => value,
  uploadBufferToCloudinary: vi.fn(async () => ({
    secure_url: "https://res.cloudinary.com/demo/image/upload/fo-proof.jpg",
    asset_id: "asset-fo-1",
    format: "jpg",
    bytes: 4,
  })),
}));
vi.mock("@/lib/account-access", () => ({
  findAccountBlockReason: vi.fn(async () => null),
  getAccountAccessBlockReason: () => null,
}));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    getSessionSecret: () => "test-session-secret",
    getSessionMaxAgeSeconds: () => 60 * 60,
  };
});

process.env.SESSION_SECRET = "test-session-secret";

const { POST: evidencePost } = await import("@/app/api/evidence/route");
const { GET: projectsGet } = await import("@/app/api/projects/route");

const milestone = { id: "m-1", project_id: "p-1", status: "pending", milestone_order: 1 };
const emptyChainSelects = [{ data: null }, { data: null }, { data: null }];

function foSession(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "90",
    name: "Ravi Officer",
    ngoId: 21,
    ngoName: "Asha Foundation",
    email: "officer@example.org",
    role: "field_officer" as const,
    issuedAt: now,
    expiresAt: now + 60 * 60 * 1000,
    deviceId: "dev-fo-1",
    createdAt: new Date(now).toISOString(),
    identityId: "fo-1",
    mustChangePassword: false,
    permissions: { can_submit_field_evidence: true },
    ...overrides,
  };
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    id: "fo-1",
    user_id: 90,
    ngo_user_id: 21,
    status: "active",
    permissions: { can_submit_field_evidence: true },
    must_change_password: false,
    last_login_at: null,
    deactivated_at: null,
    ...overrides,
  };
}

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: "fd-1",
    device_id: "dev-fo-1",
    ngo_user_id: 21,
    assigned_user_id: 90,
    device_label: "Handset",
    status: "active",
    registered_at: "2026-11-01T00:00:00Z",
    last_seen_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function withCookie(request: NextRequest, token: string) {
  request.cookies.set(SESSION_COOKIE_NAME, token);
  return request;
}

function evidenceRequest(options: {
  data?: Record<string, unknown>;
  token?: string;
  deviceHeader?: string;
  files?: File[];
} = {}) {
  const bytes = Buffer.from("abcd");
  const proof = hashMediaBytes(bytes);
  const form = new FormData();
  form.append(
    "payload",
    JSON.stringify({
      event_id: "fo-rec-1",
      event_type: "EVIDENCE_SUBMITTED",
      entity_id: "m-1",
      timestamp: "2026-11-07T10:00:00.000Z",
      data: {
        milestoneId: "m-1",
        projectId: "p-1",
        deviceId: "dev-fo-1",
        notes: "Site visit complete",
        gpsLat: 19.1,
        gpsLng: 72.8,
        mediaProofHashes: [proof],
        // Client-supplied identity must never win.
        uploaded_by: 9999,
        ngo_user_id: 9999,
        field_officer_identity_id: "spoofed",
        ...options.data,
      },
    })
  );
  for (const file of options.files ?? [new File([bytes], "proof.jpg", { type: "image/jpeg" })]) {
    form.append("files", file);
  }
  const headers: Record<string, string> = {
    cookie: `navadrishti_session=${options.token ?? "valid"}`,
    "x-device-id": options.deviceHeader ?? "dev-fo-1",
  };
  return new NextRequest("http://field.test/api/evidence", { method: "POST", body: form, headers });
}

function baseFoAuthSelects(overrides: {
  identity?: Record<string, unknown>;
  device?: Record<string, unknown> | null;
  assignments?: unknown[];
  project?: Record<string, unknown> | null;
} = {}) {
  return {
    "users.select": [
      {
        data: {
          id: 90,
          name: "Ravi Officer",
          email: "officer@example.org",
          user_type: "individual",
          account_status: "active",
          locked_until: null,
          profile_data: { role: "ngo_field_officer" },
          profile_image: null,
        },
      },
      {
        data: {
          id: 21,
          name: "Asha Foundation",
          user_type: "ngo",
          account_status: "active",
          locked_until: null,
          profile_data: {},
        },
      },
    ],
    "ngo_field_officer_identities.select": [{ data: identity(overrides.identity) }],
    "field_devices.select": [{ data: overrides.device === null ? null : device(overrides.device) }],
    "field_devices.update": [{ data: { id: "fd-1" } }],
    "ngo_field_officer_project_assignments.select": [
      { data: overrides.assignments ?? [{ project_id: "p-1", status: "active", ngo_user_id: 21 }] },
    ],
    "csr_projects.select": [
      // Evidence route ownership lookup, then assignment assert ownership lookup.
      {
        data:
          overrides.project === null
            ? null
            : { id: "p-1", ngo_user_id: 21, ...(overrides.project || {}) },
      },
      {
        data:
          overrides.project === null
            ? null
            : { id: "p-1", ngo_user_id: 21, ...(overrides.project || {}) },
      },
    ],
  };
}

beforeEach(() => {
  fake.reset({});
});

describe("Field Officer evidence submission", () => {
  it("submits evidence with FO attribution and parent NGO ownership", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      ...baseFoAuthSelects(),
      "field_events.select": [...emptyChainSelects],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
      "csr_milestone_evidence.select": [{ data: null }],
      "csr_milestone_evidence.insert": [{ data: { id: "ev-fo-1" } }],
      "csr_milestone_evidence_media.insert": [{ data: [{ id: "media-1" }] }],
      "csr_audit_log.insert": [{ data: { id: "audit-1" } }],
      "csr_project_milestones.update": [{ data: { id: "m-1", status: "submitted" } }],
      "field_events.insert": [{ data: { id: "fe-fo-1" } }],
    });

    const response = await evidencePost(withCookie(evidenceRequest({ token }), token));
    expect(response.status).toBe(200);

    const [evidenceInsert] = fake.find("csr_milestone_evidence", "insert");
    expect(evidenceInsert.payload).toMatchObject({
      milestone_id: "m-1",
      project_id: "p-1",
      uploaded_by: 90,
      ngo_user_id: 21,
      submission_status: "submitted",
    });
    expect(evidenceInsert.payload as Record<string, unknown>).toMatchObject({
      evidence_summary: {
        source: "field_officer_pwa",
        field_officer_identity_id: "fo-1",
        field_officer_user_id: 90,
      },
    });

    const [audit] = fake.find("csr_audit_log", "insert");
    expect(audit.payload).toMatchObject({
      event_type: "milestone_evidence_submitted",
      created_by: 90,
      event_payload: expect.objectContaining({
        uploaded_by: 90,
        ngo_user_id: 21,
        field_officer_identity_id: "fo-1",
        source: "field_officer_pwa",
      }),
    });
  });

  it("rejects inactive Field Officer", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      ...baseFoAuthSelects({ identity: { status: "inactive" } }),
      "csr_project_milestones.select": [{ data: milestone }],
    });
    const response = await evidencePost(withCookie(evidenceRequest({ token }), token));
    expect(response.status).toBe(403);
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
  });

  it("allows evidence when a legacy device row is revoked (device ID is metadata only)", async () => {
    const token = createSessionToken(foSession({ deviceId: "other-handset" }));
    fake.reset({
      ...baseFoAuthSelects({ device: { status: "revoked", revoked_at: "2026-11-01T00:00:00Z" } }),
      "field_events.select": [...emptyChainSelects],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
      "csr_milestone_evidence.select": [{ data: null }],
      "csr_milestone_evidence.insert": [{ data: { id: "ev-fo-revoked-meta" } }],
      "csr_milestone_evidence_media.insert": [{ data: [{ id: "media-revoked-meta" }] }],
      "csr_audit_log.insert": [{ data: { id: "audit-revoked-meta" } }],
      "csr_project_milestones.update": [{ data: { id: "m-1", status: "submitted" } }],
      "field_events.insert": [{ data: { id: "fe-fo-revoked-meta" } }],
    });
    const response = await evidencePost(
      withCookie(evidenceRequest({ token, deviceHeader: "other-handset", data: { deviceId: "other-handset" } }), token)
    );
    expect(response.status).toBe(200);
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(1);
  });

  it("rejects unassigned project", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      ...baseFoAuthSelects({ assignments: [] }),
      "csr_project_milestones.select": [{ data: milestone }],
    });
    const response = await evidencePost(withCookie(evidenceRequest({ token }), token));
    expect(response.status).toBe(403);
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
  });

  it("rejects another NGO project", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      ...baseFoAuthSelects({
        assignments: [{ project_id: "p-1", status: "active", ngo_user_id: 21 }],
        project: { ngo_user_id: 99 },
      }),
      "csr_project_milestones.select": [{ data: milestone }],
      // project ownership check happens twice (assignment assert + actor check)
      "csr_projects.select": [
        { data: { id: "p-1", ngo_user_id: 99 } },
        { data: { id: "p-1", ngo_user_id: 99 } },
      ],
    });
    const response = await evidencePost(withCookie(evidenceRequest({ token }), token));
    expect([403, 404]).toContain(response.status);
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
  });

  it("rejects missing evidence permission", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      ...baseFoAuthSelects({
        identity: { permissions: { can_submit_field_evidence: false } },
      }),
      "csr_project_milestones.select": [{ data: milestone }],
      "csr_projects.select": [
        { data: { id: "p-1", ngo_user_id: 21 } },
        { data: { id: "p-1", ngo_user_id: 21 } },
      ],
    });
    const response = await evidencePost(withCookie(evidenceRequest({ token }), token));
    expect(response.status).toBe(403);
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
  });

  it("rejects targeting a milestone from another project", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      ...baseFoAuthSelects({
        assignments: [{ project_id: "p-1", status: "active", ngo_user_id: 21 }],
      }),
      "csr_project_milestones.select": [{ data: { id: "m-other", project_id: "p-other", status: "pending" } }],
      "csr_projects.select": [{ data: { id: "p-other", ngo_user_id: 21 } }],
      "ngo_field_officer_project_assignments.select": [
        { data: [{ project_id: "p-1", status: "active", ngo_user_id: 21 }] },
      ],
    });
    const response = await evidencePost(
      withCookie(
        evidenceRequest({
          token,
          data: { milestoneId: "m-other", projectId: "p-other" },
        }),
        token
      )
    );
    expect(response.status).toBe(403);
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
  });

  it("is idempotent on event_id retry (duplicate prevention)", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      ...baseFoAuthSelects(),
      "field_events.select": [
        { data: { id: "fe-existing", payload_hash: "hash-1", ngo_id: 21, entity_id: "m-1" } },
      ],
      "csr_project_milestones.select": [{ data: milestone }],
    });
    const response = await evidencePost(withCookie(evidenceRequest({ token }), token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.eventId).toBe("fe-existing");
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
  });
});

describe("Field Officer project listing for evidence", () => {
  it("returns only assigned projects with milestone evidence status", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      ...baseFoAuthSelects(),
      "csr_projects.select": [
        {
          data: [
            {
              id: "p-1",
              title: "Assigned",
              description: null,
              region: null,
              project_status: "active",
              csr_project_milestones: [
                {
                  id: "m-1",
                  project_id: "p-1",
                  title: "Dig wells",
                  description: null,
                  milestone_order: 1,
                  status: "pending",
                  amount: 1000,
                  due_date: "2026-12-01",
                  evidence_requirements: ["Photo"],
                  updated_at: null,
                },
              ],
              reference_points: [],
            },
          ],
        },
      ],
      "csr_milestone_evidence.select": [
        {
          data: [
            {
              id: "ev-1",
              milestone_id: "m-1",
              submission_status: "submitted",
              description: "Done",
              captured_at: "2026-11-07T10:00:00Z",
              uploaded_at: null,
              gps_lat: 1,
              gps_long: 2,
              uploaded_by: 90,
            },
          ],
        },
      ],
      "csr_milestone_reviews.select": [{ data: [] }],
    });

    const response = await projectsGet(
      withCookie(
        new NextRequest("http://field.test/api/projects", {
          headers: { "x-device-id": "dev-fo-1" },
        }),
        token
      )
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.can_submit_field_evidence).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].csr_project_milestones[0].latest_evidence.id).toBe("ev-1");
  });
});

describe("hash helper sanity", () => {
  it("hashes media bytes stably", () => {
    const a = hashMediaBytes(Buffer.from("abcd"));
    const b = createHash("sha256").update(Buffer.from("abcd")).digest("hex");
    expect(a).toBe(b);
  });
});
