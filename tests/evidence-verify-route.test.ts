import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSupabaseFake } from "./supabase-fake";
import { calculateEvidenceChainHash, hashMediaBytes } from "@/lib/evidence-integrity";

const fake = createSupabaseFake();
const session = { id: "7", ngoId: 7, email: "ngo@example.org", role: "ngo" as string };

vi.mock("@/lib/supabase-server", () => ({ getServerSupabaseClient: () => fake.client }));
vi.mock("@/lib/session", () => ({
  SESSION_COOKIE_NAME: "navadrishti_session",
  verifySessionToken: (token?: string) => (token ? session : null),
}));
vi.mock("@/lib/account-access", () => ({
  findAccountBlockReason: async () => null,
}));

const { POST } = await import("@/app/api/evidence/verify/route");

function request(body: unknown, token: string | null = "valid") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.cookie = `navadrishti_session=${token}`;
  return new NextRequest("http://field.test/api/evidence/verify", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  session.role = "ngo";
});

describe("POST /api/evidence/verify", () => {
  it("requires authentication", async () => {
    const res = await POST(request({ entity_id: "m-1" }, null));
    expect(res.status).toBe(401);
  });

  it("rejects non-NGO roles", async () => {
    session.role = "individual";
    const res = await POST(request({ entity_id: "m-1" }));
    expect(res.status).toBe(403);
  });

  it("rejects missing entity_id", async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(400);
  });

  it("returns 404 for another NGO entity", async () => {
    fake.reset({
      "field_events.select": [{ data: { id: "x", ngo_id: 99 } }],
    });
    const res = await POST(request({ entity_id: "m-1" }));
    expect(res.status).toBe(404);
  });

  it("verifies a valid owned chain without exposing payloads", async () => {
    const hashes = [hashMediaBytes(Buffer.from("route"))];
    const payload = {
      media_content_hashes: hashes,
      media: [{ url: "https://res.cloudinary.com/demo/image/upload/x.jpg", content_sha256: hashes[0] }],
    };
    const payload_hash = calculateEvidenceChainHash({
      prevHash: null,
      sealedData: payload,
      mediaContentHashes: hashes,
    });
    fake.reset({
      "field_events.select": [
        { data: { id: "fe0", ngo_id: 7 } },
        {
          data: [
            {
              id: "fe1",
              event_id: "e1",
              event_type: "EVIDENCE",
              entity_id: "m-1",
              payload,
              payload_hash,
              prev_hash: null,
              user_id: "ngo@example.org",
              ngo_id: 7,
              device_id: "d",
              timestamp: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ],
    });

    const res = await POST(request({ entity_id: "m-1" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.verification.status).toBe("VALID");
    expect(json.verification.verified_event_count).toBe(1);
    expect(JSON.stringify(json)).not.toMatch(/media_content_hashes/);
  });
});
