import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseFake } from "./supabase-fake";
import { createSessionToken } from "@/lib/session";

const fake = createSupabaseFake();

vi.mock("@/lib/supabase-server", () => ({ getServerSupabaseClient: () => fake.client }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    getSessionSecret: () => "test-session-secret",
    getSessionMaxAgeSeconds: () => 60 * 60,
  };
});

process.env.SESSION_SECRET = "test-session-secret";

const { resolveFieldOfficerAssignedProjects } = await import("@/lib/field-officer-projects");

function session(overrides: Record<string, unknown> = {}) {
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
    deviceId: "dev-a",
    createdAt: new Date(now).toISOString(),
    identityId: "fo-1",
    mustChangePassword: false,
    permissions: { can_submit_field_evidence: true },
    ...overrides,
  };
}

function foAuthSelects() {
  return {
    "ngo_field_officer_identities.select": [
      {
        data: {
          id: "fo-1",
          user_id: 90,
          ngo_user_id: 21,
          status: "active",
          permissions: { can_submit_field_evidence: true },
          must_change_password: false,
          last_login_at: null,
          deactivated_at: null,
        },
      },
    ],
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
  };
}

beforeEach(() => {
  fake.reset({});
});

describe("Field Officer any-device access", () => {
  it("does not require a field_devices row for project access", async () => {
    fake.reset({
      ...foAuthSelects(),
      "ngo_field_officer_project_assignments.select": [
        {
          data: [{ project_id: "p-1", status: "active", ngo_user_id: 21 }],
        },
      ],
    });

    const access = await resolveFieldOfficerAssignedProjects(session(), {
      clientDeviceId: "brand-new-phone",
    });
    expect(access.ok).toBe(true);
    if (access.ok) {
      expect(access.projectIds).toEqual(["p-1"]);
      expect(access.deviceId).toBe("brand-new-phone");
    }
  });

  it("does not block project access when client device id differs from session device id", async () => {
    fake.reset({
      ...foAuthSelects(),
      "ngo_field_officer_project_assignments.select": [
        {
          data: [{ project_id: "p-1", status: "active", ngo_user_id: 21 }],
        },
      ],
    });

    const access = await resolveFieldOfficerAssignedProjects(session({ deviceId: "dev-a" }), {
      clientDeviceId: "dev-b-different-phone",
    });
    expect(access.ok).toBe(true);
    if (access.ok) {
      expect(access.projectIds).toEqual(["p-1"]);
      expect(access.deviceId).toBe("dev-b-different-phone");
    }
  });

  it("treats device id as metadata only (session still issues with a deviceId field)", () => {
    const token = createSessionToken(session({ deviceId: "any-handset" }));
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
  });
});
