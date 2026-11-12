import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { createSupabaseFake } from "./supabase-fake";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "@/lib/session";
import {
  fieldOfficerHasPermission,
  normalizeFieldOfficerPermissions,
} from "@/lib/field-officer-auth";

const fake = createSupabaseFake();

vi.mock("@/lib/supabase-server", () => ({
  getServerSupabaseClient: () => fake.client,
  hasServerSupabaseEnv: () => true,
  getMissingServerSupabaseEnv: () => [],
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    hasServerEnv: () => true,
    getMissingServerEnv: () => [],
    getSessionSecret: () => "test-session-secret",
    getSessionMaxAgeSeconds: () => 60 * 60,
  };
});
vi.mock("@/lib/cloudinary", () => ({
  hasCloudinaryEnv: () => true,
  sanitizeCloudinarySegment: (value: string) => value,
  uploadBufferToCloudinary: vi.fn(async () => ({
    secure_url: "https://res.cloudinary.com/demo/image/upload/x.jpg",
    asset_id: "asset-x",
    format: "jpg",
    bytes: 1,
  })),
}));

process.env.SESSION_SECRET = "test-session-secret";

const { POST: login } = await import("@/app/api/login/route");
const { GET: sessionGet } = await import("@/app/api/session/route");
const { POST: logout } = await import("@/app/api/logout/route");
const { POST: changePassword } = await import("@/app/api/auth/change-password/route");
const { GET: projectsGet } = await import("@/app/api/projects/route");
const { POST: evidencePost } = await import("@/app/api/evidence/route");

let passwordHash = "";
beforeAll(async () => {
  passwordHash = await bcrypt.hash("correct-horse", 4);
});

function officerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 90,
    name: "Ravi Officer",
    email: "officer@example.org",
    password: passwordHash,
    user_type: "individual",
    verification_status: "verified",
    account_status: "active",
    locked_until: null,
    profile_image: null,
    profile_data: { role: "ngo_field_officer", parent_ngo_user_id: 21 },
    ...overrides,
  };
}

function officerIdentity(overrides: Record<string, unknown> = {}) {
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

function loginRequest(
  email = "officer@example.org",
  password = "correct-horse"
) {
  return new NextRequest("http://field.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, device_id: "dev-fo-1" }),
  });
}

function withSessionCookie(request: NextRequest, token: string) {
  request.cookies.set(SESSION_COOKIE_NAME, token);
  return request;
}

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
    permissions: {
      can_submit_field_evidence: true,
          },
    ...overrides,
  };
}

beforeEach(() => {
  fake.reset({});
});

describe("Field Officer login", () => {
  it("signs in an active Field Officer and scopes ngoId from identity", async () => {
    fake.reset({
      "users.select": [
        { data: officerUser() },
        { data: { name: "Asha Foundation" } },
      ],
      "ngo_field_officer_identities.select": [{ data: officerIdentity() }],
      "ngo_field_officer_identities.update": [{ data: { id: "fo-1" } }],
    });

    const response = await login(loginRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      session: {
        id: "90",
        role: "field_officer",
        ngoId: 21,
        identityId: "fo-1",
        mustChangePassword: false,
      },
    });
    expect(body).not.toHaveProperty("debug");
    expect(response.headers.get("set-cookie")).toContain("navadrishti_session=");

    const updates = fake.find("ngo_field_officer_identities", "update");
    expect(updates[0]?.payload).toMatchObject({ last_login_at: expect.any(String) });
  });

  it("rejects invalid credentials without leaking account details", async () => {
    fake.reset({ "users.select": [{ data: officerUser() }] });
    const response = await login(loginRequest("officer@example.org", "wrong"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Invalid email or password.",
    });
  });

  it("rejects missing identity records", async () => {
    fake.reset({
      "users.select": [{ data: officerUser() }],
      "ngo_field_officer_identities.select": [{ data: null }],
    });
    const response = await login(loginRequest());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "This account cannot sign in.",
    });
  });

  it("rejects inactive Field Officer login", async () => {
    fake.reset({
      "users.select": [{ data: officerUser() }],
      "ngo_field_officer_identities.select": [
        { data: officerIdentity({ status: "inactive", deactivated_at: "2026-11-07T00:00:00Z" }) },
      ],
    });
    const response = await login(loginRequest());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "This account cannot sign in.",
    });
  });

  it("preserves verified NGO login behavior", async () => {
    fake.reset({
      "users.select": [
        {
          data: {
            id: 7,
            name: "Asha Foundation",
            email: "ngo@example.org",
            password: passwordHash,
            user_type: "ngo",
            verification_status: "verified",
            account_status: "active",
            locked_until: null,
            profile_data: {},
          },
        },
      ],
      "ngo_verifications.select": [
        { data: { ngo_name: "Asha Foundation", verification_status: "verified" } },
      ],
    });

    const response = await login(
      new NextRequest("http://field.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "ngo@example.org",
          password: "correct-horse",
          device_id: "dev-1",
        }),
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      session: { role: "ngo", ngoId: 7, id: "7" },
    });
  });

  it("still rejects company accounts from the field app", async () => {
    fake.reset({
      "users.select": [
        {
          data: {
            id: 6,
            name: "Company",
            email: "company@example.com",
            password: passwordHash,
            user_type: "company",
            verification_status: "verified",
            account_status: "active",
            locked_until: null,
            profile_data: {},
          },
        },
      ],
    });

    const response = await login(
      new NextRequest("http://field.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "company@example.com",
          password: "correct-horse",
          device_id: "dev-1",
        }),
      })
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Only NGO and individual accounts can use the field app.",
    });
  });
});

describe("Field Officer session enforcement", () => {
  it("rejects deactivated officers even with an existing cookie", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      "users.select": [{ data: officerUser() }],
      "ngo_field_officer_identities.select": [
        { data: officerIdentity({ status: "inactive" }) },
      ],
    });

    const response = await sessionGet(
      withSessionCookie(new NextRequest("http://field.test/api/session"), token)
    );
    const body = await response.json();
    expect(body.session).toBeNull();
    expect(response.headers.get("set-cookie") || "").toMatch(/navadrishti_session=;/);
  });

  it("rejects tampered session cookies", async () => {
    const token = createSessionToken(foSession());
    const [payload] = token.split(".");
    const tampered = `${payload}.not-a-real-signature`;

    const response = await sessionGet(
      withSessionCookie(new NextRequest("http://field.test/api/session"), tampered)
    );
    const body = await response.json();
    expect(body.session).toBeNull();
  });

  it("returns only actively assigned projects for Field Officers", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      "users.select": [
        { data: officerUser() },
        {
          data: {
            id: 21,
            user_type: "ngo",
            account_status: "active",
            locked_until: null,
            profile_data: {},
          },
        },
      ],
      "ngo_field_officer_identities.select": [{ data: officerIdentity() }],
      "field_devices.select": [
        {
          data: {
            id: "dev-row-1",
            device_id: "dev-fo-1",
            ngo_user_id: 21,
            assigned_user_id: 90,
            device_label: "Phone",
            status: "active",
            registered_at: "2026-11-01T00:00:00Z",
            last_seen_at: null,
            revoked_at: null,
          },
        },
      ],
      "field_devices.update": [{ data: { id: "dev-row-1" } }],
      "ngo_field_officer_project_assignments.select": [
        {
          data: [
            {
              project_id: "proj-assigned",
              status: "active",
              ngo_user_id: 21,
            },
          ],
        },
      ],
      "csr_projects.select": [
        {
          data: [
            {
              id: "proj-assigned",
              title: "Assigned Project",
              project_status: "active",
              csr_project_milestones: [],
              reference_points: [],
            },
            {
              id: "proj-other",
              title: "Other NGO Project",
              project_status: "active",
              csr_project_milestones: [],
              reference_points: [],
            },
          ],
        },
      ],
    });

    const response = await projectsGet(
      withSessionCookie(
        new NextRequest("http://field.test/api/projects", {
          headers: { "x-device-id": "dev-fo-1" },
        }),
        token
      )
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.role).toBe("field_officer");
    expect(body.data).toEqual([
      expect.objectContaining({ id: "proj-assigned", title: "Assigned Project" }),
    ]);
  });

  it("returns an empty project list when the Field Officer has no active assignments", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      "users.select": [
        { data: officerUser() },
        {
          data: {
            id: 21,
            user_type: "ngo",
            account_status: "active",
            locked_until: null,
            profile_data: {},
          },
        },
      ],
      "ngo_field_officer_identities.select": [{ data: officerIdentity() }],
      "field_devices.select": [
        {
          data: {
            id: "dev-row-1",
            device_id: "dev-fo-1",
            ngo_user_id: 21,
            assigned_user_id: 90,
            device_label: "Phone",
            status: "active",
            registered_at: "2026-11-01T00:00:00Z",
            last_seen_at: null,
            revoked_at: null,
          },
        },
      ],
      "field_devices.update": [{ data: { id: "dev-row-1" } }],
      "ngo_field_officer_project_assignments.select": [{ data: [] }],
    });

    const response = await projectsGet(
      withSessionCookie(
        new NextRequest("http://field.test/api/projects", {
          headers: { "x-device-id": "dev-fo-1" },
        }),
        token
      )
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("denies Field Officer project listing when the parent NGO is ineligible", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      "users.select": [
        { data: officerUser() },
        {
          data: {
            id: 21,
            user_type: "ngo",
            account_status: "banned",
            locked_until: null,
            profile_data: {},
          },
        },
      ],
      "ngo_field_officer_identities.select": [{ data: officerIdentity() }],
    });

    const response = await projectsGet(
      withSessionCookie(
        new NextRequest("http://field.test/api/projects", {
          headers: { "x-device-id": "dev-fo-1" },
        }),
        token
      )
    );
    expect(response.status).toBe(403);
  });

  it("denies Field Officer project listing when the officer identity is inactive", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      "users.select": [{ data: officerUser() }],
      "ngo_field_officer_identities.select": [
        { data: officerIdentity({ status: "inactive" }) },
      ],
    });

    const response = await projectsGet(
      withSessionCookie(
        new NextRequest("http://field.test/api/projects", {
          headers: { "x-device-id": "dev-fo-1" },
        }),
        token
      )
    );
    expect(response.status).toBe(403);
  });

  it("allows Field Officer project listing when a legacy device row is revoked", async () => {
    const token = createSessionToken(foSession());
    fake.reset({
      "users.select": [
        { data: officerUser() },
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
      "ngo_field_officer_identities.select": [{ data: officerIdentity() }],
      "field_devices.select": [
        {
          data: {
            id: "dev-row-1",
            device_id: "dev-fo-1",
            ngo_user_id: 21,
            assigned_user_id: 90,
            device_label: "Phone",
            status: "revoked",
            registered_at: "2026-11-01T00:00:00Z",
            last_seen_at: null,
            revoked_at: "2026-11-07T00:00:00Z",
          },
        },
      ],
      "ngo_field_officer_project_assignments.select": [{ data: [] }],
      "csr_projects.select": [{ data: [] }],
    });

    const response = await projectsGet(
      withSessionCookie(
        new NextRequest("http://field.test/api/projects", {
          headers: { "x-device-id": "dev-fo-1" },
        }),
        token
      )
    );
    // Device binding is not an authorization gate; any-device auth is allowed.
    expect(response.status).toBe(200);
  });

  it("does not treat Field Officer sessions as NGO admin for bare evidence posts", async () => {
    fake.reset({
      "field_events.select": [{ data: null }],
    });
    const token = createSessionToken(foSession());
    const form = new FormData();
    form.append("payload", JSON.stringify({ event_id: "x" }));
    const response = await evidencePost(
      withSessionCookie(
        new NextRequest("http://field.test/api/evidence", {
          method: "POST",
          headers: { "x-device-id": "dev-fo-1" },
          body: form,
        }),
        token
      )
    );
    // FO is allowed into the evidence route; missing milestone/project yields 400 (not NGO-only 403).
    expect(response.status).toBe(400);
    const parsed = verifySessionToken(token);
    expect(parsed?.role).toBe("field_officer");
    expect(parsed?.role).not.toBe("ngo");
  });

  it("cannot be interpreted as Company CA or Admin via session role", () => {
    const session = verifySessionToken(createSessionToken(foSession()));
    expect(session?.role).toBe("field_officer");
    expect(session?.role).not.toBe("ngo");
    expect(["company_ca", "admin", "platform_ca"]).not.toContain(session?.role);
  });
});

describe("Field Officer password change", () => {
  it("enforces mandatory password change on login", async () => {
    fake.reset({
      "users.select": [
        { data: officerUser() },
        { data: { name: "Asha Foundation" } },
      ],
      "ngo_field_officer_identities.select": [
        { data: officerIdentity({ must_change_password: true }) },
      ],
      "ngo_field_officer_identities.update": [{ data: { id: "fo-1" } }],
    });

    const response = await login(loginRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.mustChangePassword).toBe(true);
    expect(body.session.mustChangePassword).toBe(true);
  });

  it("clears must_change_password after a successful password change", async () => {
    const token = createSessionToken(foSession({ mustChangePassword: true }));
    fake.reset({
      "users.select": [
        { data: officerUser() },
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
        { data: { id: 90, password: passwordHash } },
      ],
      "ngo_field_officer_identities.select": [
        { data: officerIdentity({ must_change_password: true }) },
      ],
      "users.update": [{ data: { id: 90 } }],
      "ngo_field_officer_identities.update": [
        { data: { id: "fo-1", must_change_password: false } },
      ],
    });

    const response = await changePassword(
      withSessionCookie(
        new NextRequest("http://field.test/api/auth/change-password", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            currentPassword: "correct-horse",
            newPassword: "new-horse-battery",
          }),
        }),
        token
      )
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.session.mustChangePassword).toBe(false);

    const identityUpdates = fake.find("ngo_field_officer_identities", "update");
    expect(
      identityUpdates.some(
        (q) => (q.payload as { must_change_password?: boolean })?.must_change_password === false
      )
    ).toBe(true);
  });

  it("preserves must_change_password when current password is wrong", async () => {
    const token = createSessionToken(foSession({ mustChangePassword: true }));
    fake.reset({
      "users.select": [
        { data: officerUser() },
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
        { data: { id: 90, password: passwordHash } },
      ],
      "ngo_field_officer_identities.select": [
        { data: officerIdentity({ must_change_password: true }) },
      ],
    });

    const response = await changePassword(
      withSessionCookie(
        new NextRequest("http://field.test/api/auth/change-password", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            currentPassword: "wrong-password",
            newPassword: "new-horse-battery",
          }),
        }),
        token
      )
    );
    expect(response.status).toBe(400);
    expect(fake.find("users", "update")).toHaveLength(0);
    expect(
      fake
        .find("ngo_field_officer_identities", "update")
        .filter((q) =>
          Object.prototype.hasOwnProperty.call(q.payload || {}, "must_change_password")
        )
    ).toHaveLength(0);
  });
});

describe("Field Officer logout and permissions", () => {
  it("clears the Field Officer session cookie on logout", async () => {
    const response = await logout();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") || "").toMatch(/navadrishti_session=;/);
    expect(response.headers.get("set-cookie") || "").toMatch(/Max-Age=0/i);
  });

  it("defaults missing or malformed permissions to deny", () => {
    expect(fieldOfficerHasPermission(null, "can_submit_field_evidence")).toBe(false);
    expect(fieldOfficerHasPermission(undefined, "can_submit_field_evidence")).toBe(false);
    expect(fieldOfficerHasPermission("bad", "can_submit_field_evidence")).toBe(false);
    expect(fieldOfficerHasPermission({}, "can_submit_field_evidence")).toBe(false);
    expect(fieldOfficerHasPermission({ can_submit_field_evidence: "yes" }, "can_submit_field_evidence")).toBe(
      false
    );
    expect(normalizeFieldOfficerPermissions({ can_mark_attendance: true })).toEqual({
      can_submit_field_evidence: false,
    });
  });
});
