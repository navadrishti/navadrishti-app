import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient, hasServerSupabaseEnv } from "@/lib/supabase-server";

export const runtime = "nodejs";

interface SupabaseMilestone {
  id: string;
  title: string;
  description: string | null;
  milestone_order: number;
  amount: number;
  evidence_requirements: string[] | null;
  status: string;
  due_date: string | null;
}

interface SupabaseProject {
  id: string;
  title: string;
  description: string | null;
  region: string | null;
  project_status: string;
  acceptance_date: string | null;
  progress_percentage: number | null;
  funds_utilized: number | null;
  expected_beneficiaries: number | null;
  csr_project_milestones: SupabaseMilestone[];
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  if (!hasServerSupabaseEnv()) {
    return NextResponse.json({ ok: true, projects: [] });
  }

  try {
    const supabase = getServerSupabaseClient();

    const { data, error } = await supabase
      .from("csr_projects")
      .select(
        `id, title, description, region, project_status,
         acceptance_date, progress_percentage, funds_utilized, expected_beneficiaries,
         csr_project_milestones (
           id, title, description, milestone_order, amount,
           evidence_requirements, status, due_date
         )`,
      )
      .eq("ngo_user_id", session.ngoId)
      .in("project_status", ["active", "completed"])
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[api/projects]", error.message);
      return NextResponse.json({ ok: true, projects: [] });
    }

    return NextResponse.json({ ok: true, projects: (data as SupabaseProject[]) ?? [] });
  } catch (err) {
    console.error("[api/projects] unexpected:", err);
    return NextResponse.json({ ok: true, projects: [] });
  }
}
