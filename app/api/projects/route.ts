import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);

  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  if (session.role !== "ngo") {
    return NextResponse.json(
      { ok: false, error: "Projects are available for NGO accounts." },
      { status: 403 }
    );
  }

  const supabase = getServerSupabaseClient();

  const { data, error } = await supabase
    .from("csr_projects")
    .select(
      `
      id, title, description, region, project_status,
      csr_project_milestones (
        id, project_id, title, description, milestone_order, status, amount, updated_at
      ),
      reference_points (
        id, project_id, name, latitude, longitude, updated_at
      )
    `
    )
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
