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
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getServerSupabaseClient();

  // ─── GOV BRANCH: Infrastructure Flow ───────────────────────────────────
  if (session.role === "gov") {
    const { data, error } = await supabase
      .from("awc_sites")
      .select(`
        id, name, district, block, state, address, is_active, updated_at,
        awc_reference_points (
          id, site_id, name, latitude, longitude, radius_meters, image_url
        )
      `)
      .eq("is_active", true)
      .order("name", { ascending: true });

    if (error) {
      console.error("[api/projects][gov]", error.message);
      return NextResponse.json({ ok: true, role: "gov", data: [] });
    }

    const sites = (data ?? []).map(site => ({
      id: site.id,
      name: site.name,
      district: site.district,
      block: site.block,
      state: site.state,
      address: site.address,
      updated_at: site.updated_at,
      reference_points: (site.awc_reference_points ?? []).map((rp: any) => ({
        id: rp.id,
        site_id: rp.site_id,
        name: rp.name,
        latitude: rp.latitude,
        longitude: rp.longitude,
        radius_meters: rp.radius_meters,
        image_url: rp.image_url,
      }))
    }));

    return NextResponse.json({ ok: true, role: "gov", data: sites });
  }

  // ─── NGO / FIELD BRANCH: CSR Flow ──────────────────────────────────────
  let query = supabase
    .from("csr_projects")
    .select(`
      id, title, description, region, project_status,
      csr_project_milestones (
        id, project_id, title, description, milestone_order, status, amount, updated_at
      ),
      reference_points (
        id, project_id, name, latitude, longitude, updated_at
      )
    `);

  if (session.role === "ngo" || session.role === "field") {
    query = query.eq("ngo_user_id", session.ngoId);
  }

  const { data, error } = await query.order("title", { ascending: true });

  if (error) {
    console.error("[api/projects] Database error:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    role: "ngo",
    data: data || []
  });
}
