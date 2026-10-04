import { beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { createSupabaseFake } from "./supabase-fake";

const fake = createSupabaseFake();

vi.mock("@/lib/supabase-server", () => ({
  getServerSupabaseClient: () => fake.client,
  hasServerSupabaseEnv: () => true,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));

process.env.SESSION_SECRET = "test-session-secret";

const { POST } = await import("@/app/api/login/route");

let passwordHash = "";
beforeAll(async () => {
  passwordHash = await bcrypt.hash("correct-horse", 4);
});

function ngoUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: "Asha Foundation",
    email: "ngo@example.org",
    password: passwordHash,
    user_type: "ngo",
    verification_status: "verified",
    account_status: "active",
    locked_until: null,
    profile_data: {},
    ...overrides,
  };
}

function individualUser(overrides: Record<string, unknown> = {}) {
  return {
    ...ngoUser(),
    id: 8,
    name: "Ravi Kumar",
    email: "individual@example.org",
    user_type: "individual",
    ...overrides,
  };
}

function loginRequest(password = "correct-horse") {
  return new NextRequest("http://field.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ngo@example.org", password, device_id: "dev-1" }),
  });
}

describe("POST /api/login", () => {
  it("signs in a verified NGO without exposing debug details", async () => {
    fake.reset({
      "users.select": [{ data: ngoUser() }],
      "ngo_verifications.select": [{ data: { ngo_name: "Asha Foundation", verification_status: "verified" } }],
    });

    const response = await POST(loginRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, session: { ngoId: 7, role: "ngo" } });
    expect(body).not.toHaveProperty("debug");
    expect(response.headers.get("set-cookie")).toContain("navadrishti_session=");
  });

  it("rejects a wrong password without revealing why", async () => {
    fake.reset({ "users.select": [{ data: ngoUser() }] });
    const response = await POST(loginRequest("wrong"));
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body).toEqual({ ok: false, error: "Invalid email or password." });
  });

  it("never authenticates against a plaintext stored password", async () => {
    fake.reset({ "users.select": [{ data: ngoUser({ password: "correct-horse" }) }] });
    const response = await POST(loginRequest());
    expect(response.status).toBe(401);
  });

  it("blocks suspended accounts, as the platform login does", async () => {
    fake.reset({ "users.select": [{ data: ngoUser({ account_status: "suspended" }) }] });
    const response = await POST(loginRequest());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "This account is currently suspended." });
  });

  it("hides database error details", async () => {
    fake.reset({ "users.select": [{ error: { message: "relation users does not exist" } }] });
    const response = await POST(loginRequest());
    const body = await response.json();
    expect(body.error).not.toMatch(/relation/);
  });

  it("requires a verified individual verification record", async () => {
    fake.reset({
      "users.select": [{ data: individualUser() }],
      "individual_verifications.select": [{ data: { verification_status: "pending" } }],
    });

    const response = await POST(
      new NextRequest("http://field.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "individual@example.org",
          password: "correct-horse",
          device_id: "dev-1",
        }),
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Verification is pending"),
    });
  });
});
