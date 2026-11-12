import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseFake } from "./supabase-fake";

const fake = createSupabaseFake();

vi.mock("@/lib/supabase-server", () => ({ getServerSupabaseClient: () => fake.client }));

const {
  CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND,
  isEligibleAssignedCampaignVolunteer,
  listAttendanceAssignments,
} = await import("@/lib/attendance");

const FIELD_USER_ID = 4;
const OTHER_USER_ID = 99;
const LEAD_NGO_ID = 2;
const COMPANY_ID = 1;
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111101";

const liveCampaign = {
  id: CAMPAIGN_ID,
  title: "E2E Synthetic CSR Campaign",
  location: "Bengaluru, Karnataka",
  status: "active",
  start_date: "2026-01-01",
  end_date: "2099-12-31",
  lead_ngo_user_id: LEAD_NGO_ID,
  company_id: COMPANY_ID,
  impact_metrics: { e2e_seed: true, beneficiaries_target: 100 },
};

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: "as-field-1",
    target_type: "campaign",
    target_id: CAMPAIGN_ID,
    owner_user_id: COMPANY_ID,
    assignee_user_id: FIELD_USER_ID,
    status: "active",
    meta: {
      engagement_kind: CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND,
      volunteer_capacity: 1,
    },
    ...overrides,
  };
}

describe("isEligibleAssignedCampaignVolunteer", () => {
  it("accepts an active campaign volunteer assignment for the session user", () => {
    expect(isEligibleAssignedCampaignVolunteer(assignment(), FIELD_USER_ID)).toBe(true);
  });

  it("rejects inactive assignment status", () => {
    expect(isEligibleAssignedCampaignVolunteer(assignment({ status: "cancelled" }), FIELD_USER_ID)).toBe(
      false
    );
    expect(isEligibleAssignedCampaignVolunteer(assignment({ status: "completed" }), FIELD_USER_ID)).toBe(
      false
    );
  });

  it("rejects assignments owned by another user as assignee", () => {
    expect(
      isEligibleAssignedCampaignVolunteer(assignment({ assignee_user_id: OTHER_USER_ID }), FIELD_USER_ID)
    ).toBe(false);
  });

  it("rejects invalid target type", () => {
    expect(
      isEligibleAssignedCampaignVolunteer(
        assignment({ target_type: "service_request", meta: { engagement_kind: CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND } }),
        FIELD_USER_ID
      )
    ).toBe(false);
  });

  it("rejects wrong engagement kind", () => {
    expect(
      isEligibleAssignedCampaignVolunteer(
        assignment({ meta: { engagement_kind: "skill_service" } }),
        FIELD_USER_ID
      )
    ).toBe(false);
  });

  it("accepts csr_project only with campaign_volunteer engagement kind", () => {
    expect(
      isEligibleAssignedCampaignVolunteer(
        assignment({
          target_type: "csr_project",
          meta: { engagement_kind: CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND, campaign_id: CAMPAIGN_ID },
        }),
        FIELD_USER_ID
      )
    ).toBe(true);
    expect(
      isEligibleAssignedCampaignVolunteer(
        assignment({ target_type: "csr_project", meta: { engagement_kind: "other" } }),
        FIELD_USER_ID
      )
    ).toBe(false);
  });
});

describe("listAttendanceAssignments campaign visibility", () => {
  beforeEach(() => {
    fake.reset({});
  });

  it("shows an assigned field worker campaign without volunteer_applications", async () => {
    fake.reset({
      "service_engagement_assignments.select": [{ data: [assignment()] }],
      "campaigns.select": [{ data: [liveCampaign] }],
      "users.select": [{ data: [{ id: COMPANY_ID, name: "E2E Company", email: "co@test" }] }],
    });

    const result = await listAttendanceAssignments(FIELD_USER_ID);
    expect(result.active.campaignItems).toHaveLength(1);
    expect(result.active.campaignItems[0].assignment_id).toBe("as-field-1");
    expect(result.active.campaignItems[0].title).toBe("E2E Synthetic CSR Campaign");
    expect(result.active.campaignItems[0].can_mark).toBe(true);
    expect(result.history.campaignItems).toHaveLength(0);
  });

  it("does not show campaigns for inactive assignments", async () => {
    fake.reset({
      "service_engagement_assignments.select": [{ data: [assignment({ status: "cancelled" })] }],
      "campaigns.select": [{ data: [liveCampaign] }],
      "users.select": [{ data: [] }],
    });

    const result = await listAttendanceAssignments(FIELD_USER_ID);
    expect(result.active.campaignItems).toHaveLength(0);
    expect(result.history.campaignItems).toHaveLength(0);
  });

  it("does not show campaigns assigned to another user", async () => {
    fake.reset({
      "service_engagement_assignments.select": [
        { data: [assignment({ assignee_user_id: OTHER_USER_ID })] },
      ],
      "campaigns.select": [{ data: [liveCampaign] }],
      "users.select": [{ data: [] }],
    });

    const result = await listAttendanceAssignments(FIELD_USER_ID);
    expect(result.active.campaignItems).toHaveLength(0);
  });

  it("rejects invalid target type / engagement kind on the assignment path", async () => {
    fake.reset({
      "service_engagement_assignments.select": [
        {
          data: [
            assignment({ target_type: "service_offer", meta: { engagement_kind: CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND } }),
            assignment({ id: "as-2", meta: { engagement_kind: "other" } }),
          ],
        },
      ],
      "campaigns.select": [{ data: [liveCampaign] }],
      "users.select": [{ data: [] }],
    });

    const result = await listAttendanceAssignments(FIELD_USER_ID);
    expect(result.active.campaignItems).toHaveLength(0);
  });

  it("keeps ordinary volunteer eligibility without a pre-existing assignment", async () => {
    const volunteerCampaign = {
      ...liveCampaign,
      id: "camp-vol-1",
      impact_metrics: {
        volunteer_applications: [{ user_id: FIELD_USER_ID, capacity: 2, user_type: "individual" }],
      },
    };
    fake.reset({
      "service_engagement_assignments.select": [
        { data: [] },
        { data: assignment({ id: "as-created", target_id: "camp-vol-1", status: "active" }) },
      ],
      "campaigns.select": [{ data: [volunteerCampaign] }],
      "service_engagement_assignments.insert": [
        { data: assignment({ id: "as-created", target_id: "camp-vol-1" }) },
      ],
      "users.select": [{ data: [{ id: COMPANY_ID, name: "E2E Company", email: "co@test" }] }],
    });

    const result = await listAttendanceAssignments(FIELD_USER_ID);
    expect(result.active.campaignItems).toHaveLength(1);
    expect(result.active.campaignItems[0].title).toBe("E2E Synthetic CSR Campaign");
    expect(result.active.campaignItems[0].volunteer_capacity).toBe(2);
    expect(fake.find("service_engagement_assignments", "insert")).toHaveLength(1);
  });

  it("dedupes when both volunteer application and assignment paths match", async () => {
    const bothPathsCampaign = {
      ...liveCampaign,
      impact_metrics: {
        volunteer_applications: [{ user_id: FIELD_USER_ID, capacity: 1 }],
      },
    };
    fake.reset({
      "service_engagement_assignments.select": [{ data: [assignment()] }],
      "campaigns.select": [{ data: [bothPathsCampaign] }],
      "users.select": [{ data: [{ id: COMPANY_ID, name: "E2E Company", email: "co@test" }] }],
    });

    const result = await listAttendanceAssignments(FIELD_USER_ID);
    expect(result.active.campaignItems).toHaveLength(1);
    expect(result.active.campaignItems[0].assignment_id).toBe("as-field-1");
  });

  it("does not list campaigns for the lead NGO via the assignment path", async () => {
    fake.reset({
      "service_engagement_assignments.select": [
        {
          data: [
            assignment({
              assignee_user_id: LEAD_NGO_ID,
              meta: { engagement_kind: CAMPAIGN_VOLUNTEER_ENGAGEMENT_KIND },
            }),
          ],
        },
      ],
      "campaigns.select": [{ data: [liveCampaign] }],
      "users.select": [{ data: [{ id: COMPANY_ID, name: "E2E Company", email: "co@test" }] }],
    });

    const result = await listAttendanceAssignments(LEAD_NGO_ID);
    expect(result.active.campaignItems).toHaveLength(0);
    expect(result.history.campaignItems).toHaveLength(0);
  });
});
