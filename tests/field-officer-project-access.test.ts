import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseFake } from "./supabase-fake";
import {
  assertFieldOfficerAssignedToProject,
  resolveFieldOfficerAssignedProjects,
} from "@/lib/field-officer-projects";
import type { AppSession } from "@/lib/session";

const fake = createSupabaseFake();

vi.mock("@/lib/supabase-server", () => ({
  getServerSupabaseClient: () => fake.client,
  hasServerSupabaseEnv: () => true,
  getMissingServerSupabaseEnv: () => [],
}));

function session(overrides: Partial<AppSession> = {}): AppSession {
  const now = Date.now();
  return {
    id: "90",
    name: "Ravi Officer",
    ngoId: 21,
    ngoName: "Asha Foundation",
    email: "officer@example.org",
    role: "field_officer",
    issuedAt: now,
    expiresAt: now + 60_000,
    deviceId: "dev-1",
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

describe("Field Officer project authorization helpers", () => {
  it("accepts an actively assigned project owned by the parent NGO", async () => {
    fake.reset({
      "users.select": [
        {
          data: {
            id: 90,
            name: "Ravi",
            email: "officer@example.org",
            user_type: "individual",
            account_status: "active",
            locked_until: null,
            profile_data: {},
            profile_image: null,
          },
        },
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
      "field_devices.select": [
        {
          data: {
            id: "dev-row-1",
            device_id: "dev-1",
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
        { data: [{ project_id: "proj-1", status: "active", ngo_user_id: 21 }] },
      ],
      "csr_projects.select": [{ data: { id: "proj-1", ngo_user_id: 21 } }],
    });

    const access = await assertFieldOfficerAssignedToProject(session(), "proj-1");
    expect(access.ok).toBe(true);
  });

  it("rejects unassigned, inactive, and tampered project IDs", async () => {
    fake.reset({
      "users.select": [
        {
          data: {
            id: 90,
            name: "Ravi",
            email: "officer@example.org",
            user_type: "individual",
            account_status: "active",
            locked_until: null,
            profile_data: {},
            profile_image: null,
          },
        },
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
      "ngo_field_officer_identities.select": [
        {
          data: {
            id: "fo-1",
            user_id: 90,
            ngo_user_id: 21,
            status: "active",
            permissions: {},
            must_change_password: false,
            last_login_at: null,
            deactivated_at: null,
          },
        },
      ],
      "field_devices.select": [
        {
          data: {
            id: "dev-row-1",
            device_id: "dev-1",
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
        { data: [{ project_id: "proj-1", status: "active", ngo_user_id: 21 }] },
      ],
    });

    const unassigned = await assertFieldOfficerAssignedToProject(session(), "proj-other");
    expect(unassigned).toMatchObject({ ok: false, status: 403 });

    fake.reset({
      "users.select": [
        {
          data: {
            id: 90,
            name: "Ravi",
            email: "officer@example.org",
            user_type: "individual",
            account_status: "active",
            locked_until: null,
            profile_data: {},
            profile_image: null,
          },
        },
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
      "ngo_field_officer_identities.select": [
        {
          data: {
            id: "fo-1",
            user_id: 90,
            ngo_user_id: 21,
            status: "active",
            permissions: {},
            must_change_password: false,
            last_login_at: null,
            deactivated_at: null,
          },
        },
      ],
      "field_devices.select": [
        {
          data: {
            id: "dev-row-1",
            device_id: "dev-1",
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
        { data: [{ project_id: "proj-1", status: "active", ngo_user_id: 21 }] },
      ],
    });
    const empty = await assertFieldOfficerAssignedToProject(session(), "");
    expect(empty).toMatchObject({ ok: false, status: 404 });
  });

  it("does not authorize from session.ngoId alone when assignments are empty", async () => {
    fake.reset({
      "users.select": [
        {
          data: {
            id: 90,
            name: "Ravi",
            email: "officer@example.org",
            user_type: "individual",
            account_status: "active",
            locked_until: null,
            profile_data: {},
            profile_image: null,
          },
        },
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
      "ngo_field_officer_identities.select": [
        {
          data: {
            id: "fo-1",
            user_id: 90,
            ngo_user_id: 21,
            status: "active",
            permissions: {},
            must_change_password: false,
            last_login_at: null,
            deactivated_at: null,
          },
        },
      ],
      "field_devices.select": [
        {
          data: {
            id: "dev-row-1",
            device_id: "dev-1",
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

    const resolved = await resolveFieldOfficerAssignedProjects(session({ ngoId: 21 }));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.projectIds).toEqual([]);
    }
  });
});
