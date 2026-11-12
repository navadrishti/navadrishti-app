import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { resolveFieldOfficerAssignedProjects } from "@/lib/field-officer-projects";
import { fieldOfficerHasPermission } from "@/lib/field-officer-auth";

export const runtime = "nodejs";

const PROJECT_SELECT = `
  id, title, description, region, project_status,
  csr_project_milestones (
    id, project_id, title, description, milestone_order, status, amount,
    due_date, evidence_requirements, updated_at
  ),
  reference_points:csr_reference_points (
    id, project_id, name, latitude, longitude, radius_meters, updated_at
  )
`;

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getServerSupabaseClient();

  if (session.role === "field_officer") {
    try {
      const clientDeviceId = request.headers.get("x-device-id");
      const access = await resolveFieldOfficerAssignedProjects(session, {
        clientDeviceId,
      });
      if (!access.ok) {
        return NextResponse.json(
          { ok: false, error: access.error },
          { status: access.status }
        );
      }

      if (access.projectIds.length === 0) {
        return NextResponse.json({
          ok: true,
          role: "field_officer",
          data: [],
        });
      }

      const { data, error } = await supabase
        .from("csr_projects")
        .select(PROJECT_SELECT)
        .eq("ngo_user_id", access.identity.ngo_user_id)
        .in("id", access.projectIds)
        .order("title", { ascending: true });

      if (error) {
        console.error("[api/projects] field officer", error);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      }

      // Defense in depth: only return projects that remain in the assigned ID set
      // and belong to the DB-resolved parent NGO (never session.ngoId alone).
      const allowed = new Set(access.projectIds);
      const scoped = (data || []).filter((project) => allowed.has(String(project.id)));

      const milestoneIds = scoped.flatMap((project) =>
        (project.csr_project_milestones || []).map((m: { id: string }) => String(m.id))
      );

      let evidenceByMilestone: Record<
        string,
        Array<{
          id: string;
          milestone_id: string;
          submission_status: string;
          description: string | null;
          captured_at: string;
          uploaded_at: string | null;
          gps_lat: number | null;
          gps_long: number | null;
          uploaded_by: number;
        }>
      > = {};
      let reviewsByMilestone: Record<
        string,
        Array<{ decision: string; comments: string | null; reviewed_at: string | null }>
      > = {};

      if (milestoneIds.length > 0) {
        const [evidenceResult, reviewResult] = await Promise.all([
          supabase
            .from("csr_milestone_evidence")
            .select(
              "id, milestone_id, submission_status, description, captured_at, uploaded_at, gps_lat, gps_long, uploaded_by"
            )
            .in("milestone_id", milestoneIds)
            .eq("ngo_user_id", access.identity.ngo_user_id)
            .order("created_at", { ascending: false }),
          supabase
            .from("csr_milestone_reviews")
            .select("milestone_id, decision, comments, reviewed_at")
            .in("milestone_id", milestoneIds)
            .order("created_at", { ascending: false }),
        ]);

        if (evidenceResult.error) {
          console.error("[api/projects] field officer evidence", evidenceResult.error);
          return NextResponse.json({ ok: false, error: "Unable to load evidence status." }, { status: 500 });
        }
        if (reviewResult.error) {
          console.error("[api/projects] field officer reviews", reviewResult.error);
          return NextResponse.json({ ok: false, error: "Unable to load review status." }, { status: 500 });
        }

        for (const row of evidenceResult.data ?? []) {
          const key = String(row.milestone_id);
          if (!evidenceByMilestone[key]) evidenceByMilestone[key] = [];
          evidenceByMilestone[key].push(row);
        }
        for (const row of reviewResult.data ?? []) {
          const key = String(row.milestone_id);
          if (!reviewsByMilestone[key]) reviewsByMilestone[key] = [];
          reviewsByMilestone[key].push(row);
        }
      }

      const withEvidence = scoped.map((project) => ({
        ...project,
        csr_project_milestones: (project.csr_project_milestones || []).map(
          (milestone: Record<string, unknown>) => {
            const mid = String(milestone.id);
            const evidence = evidenceByMilestone[mid] || [];
            const reviews = reviewsByMilestone[mid] || [];
            return {
              ...milestone,
              evidence,
              latest_evidence: evidence[0] || null,
              latest_review: reviews[0] || null,
            };
          }
        ),
      }));

      return NextResponse.json({
        ok: true,
        role: "field_officer",
        can_submit_field_evidence: fieldOfficerHasPermission(
          access.identity.permissions,
          "can_submit_field_evidence"
        ),
        data: withEvidence,
      });
    } catch (error) {
      console.error("[api/projects] field officer authorization failed:", error);
      return NextResponse.json(
        { ok: false, error: "Unable to load assigned projects." },
        { status: 500 }
      );
    }
  }

  if (session.role !== "ngo") {
    return NextResponse.json(
      {
        ok: false,
        error: "Projects are available for NGO accounts.",
      },
      { status: 403 }
    );
  }

  const { data, error } = await supabase
    .from("csr_projects")
    .select(PROJECT_SELECT)
    .eq("ngo_user_id", session.ngoId)
    .order("title", { ascending: true });

  if (error) {
    console.error("[api/projects]", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    role: "ngo",
    data: data || [],
  });
}
