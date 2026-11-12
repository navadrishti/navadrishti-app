import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { createSupabaseFake } from "./supabase-fake";
import { calculateEvidenceChainHash, hashMediaBytes } from "@/lib/evidence-integrity";

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

/** Existing-event + tip + tip-occupancy selects for a new submission. */
const emptyChainSelects = [{ data: null }, { data: null }, { data: null }];

function evidenceRequest(
  options: {
    data?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    files?: File[];
    token?: string | null;
  } = {}
) {
  const form = new FormData();
  form.append(
    "payload",
    JSON.stringify({
      event_id: "rec-1",
      event_type: "EVIDENCE_SUBMITTED",
      entity_id: "m-1",
      timestamp: "2026-09-28T10:00:00.000Z",
      data: {
        milestoneId: "m-1",
        projectId: "p-1",
        deviceId: "dev-1",
        notes: "Visited site",
        gpsLat: 19.1,
        gpsLng: 72.8,
        ...options.data,
      },
      ...options.payload,
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
      "field_events.select": [...emptyChainSelects],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
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
    const eventInsert = fake.find("field_events", "insert")[0].payload as {
      event_id: string;
      entity_id: string;
      ngo_id: number;
      payload_hash: string;
      prev_hash: string | null;
      payload: { media_content_hashes: string[] };
    };
    expect(eventInsert).toMatchObject({ event_id: "rec-1", entity_id: "m-1", ngo_id: 7, prev_hash: null });
    expect(eventInsert.payload_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(eventInsert.payload.media_content_hashes).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    const evidencePayload = evidenceInsert.payload as {
      evidence_summary: {
        source?: string;
        field_event_id?: string;
        payload_hash?: string;
        media_content_hashes: string[];
      };
    };
    expect(evidencePayload.evidence_summary).toMatchObject({
      source: "field_pwa",
      field_event_id: "rec-1",
      payload_hash: eventInsert.payload_hash,
    });
    expect(evidencePayload.evidence_summary.media_content_hashes).toEqual(
      eventInsert.payload.media_content_hashes
    );
  });

  it("rejects files that do not match declared media_proof_hashes", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: null }],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
    });
    const response = await POST(
      evidenceRequest({
        data: { mediaProofHashes: ["0".repeat(64)] },
      })
    );
    expect(response.status).toBe(400);
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
  });

  it("rejects modified media against a valid-looking proof hash of different bytes", async () => {
    const otherHash = createHash("sha256").update("other-bytes").digest("hex");
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: null }],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
    });
    const response = await POST(
      evidenceRequest({
        data: { mediaProofHashes: [otherHash] },
        files: [new File(["abcd"], "proof.jpg", { type: "image/jpeg" })],
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/does not match/i),
    });
  });

  it("rejects an invalid expected_prev_hash that does not match the tip", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [
        { data: null },
        { data: { id: "fe-tip", payload_hash: "a".repeat(64), timestamp: "2026-01-01T00:00:00Z" } },
      ],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
    });
    const response = await POST(
      evidenceRequest({
        payload: { expected_prev_hash: "b".repeat(64) },
      })
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/chain tip/i),
    });
    expect(fake.find("field_events", "insert")).toHaveLength(0);
  });

  it("rejects concurrent appends when the tip link is already occupied", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [
        { data: null },
        { data: { id: "fe-tip", payload_hash: "c".repeat(64), timestamp: "2026-01-01T00:00:00Z" } },
        { data: { id: "fe-child" } },
      ],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
    });
    const response = await POST(
      evidenceRequest({
        payload: { expected_prev_hash: "c".repeat(64) },
      })
    );
    expect(response.status).toBe(409);
    expect(fake.find("field_events", "insert")).toHaveLength(0);
  });

  it("links prev_hash to the server tip and seals media hashes into the chain", async () => {
    const tip = "d".repeat(64);
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [
        { data: null },
        { data: { id: "fe-tip", payload_hash: tip, timestamp: "2026-01-01T00:00:00Z" } },
        { data: null },
      ],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
      "csr_milestone_evidence.select": [{ data: null }],
      "csr_milestone_evidence.insert": [{ data: { id: "ev-1" } }],
      "field_events.insert": [{ data: { id: "fe-2" } }],
    });

    const response = await POST(
      evidenceRequest({
        payload: { expected_prev_hash: tip },
      })
    );
    expect(response.status).toBe(200);
    const eventInsert = fake.find("field_events", "insert")[0].payload as {
      prev_hash: string | null;
      payload_hash: string;
      payload: Record<string, unknown>;
    };
    expect(eventInsert.prev_hash).toBe(tip);
    const mediaHash = hashMediaBytes(Buffer.from("abcd"));
    expect(
      calculateEvidenceChainHash({
        prevHash: tip,
        sealedData: eventInsert.payload,
        mediaContentHashes: [mediaHash],
      })
    ).toBe(eventInsert.payload_hash);
  });

  it("refuses evidence for another NGO's milestone without uploading anything", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [{ data: null }],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
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
      "field_events.select": [{ data: { id: "fe-1", payload_hash: "hash", ngo_id: 7, entity_id: "m-1" } }],
    });

    const response = await POST(evidenceRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, eventId: "fe-1" });
    expect(fake.find("csr_milestone_evidence", "insert")).toHaveLength(0);
  });

  it("maps tip-unique 23505 to 409 instead of false success", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [
        { data: null },
        { data: { id: "fe-tip", payload_hash: "e".repeat(64), timestamp: "2026-01-01T00:00:00Z" } },
        { data: null },
        { data: null }, // post-23505 event_id lookup → not found ⇒ tip conflict
      ],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
      "csr_projects.select": [{ data: { id: "p-1", ngo_user_id: 7 } }],
      "csr_milestone_evidence.select": [{ data: null }],
      "csr_milestone_evidence.insert": [{ data: { id: "ev-1" } }],
      "field_events.insert": [{ error: { code: "23505", message: "duplicate key" } }],
    });

    const response = await POST(
      evidenceRequest({
        payload: { expected_prev_hash: "e".repeat(64) },
      })
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/chain tip/i),
    });
  });

  it("reuses evidence written by an interrupted earlier attempt", async () => {
    fake.reset({
      "users.select": [activeUser],
      "field_events.select": [...emptyChainSelects],
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
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
      "csr_project_milestones.select": [{ data: milestone }, { data: [milestone] }],
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
