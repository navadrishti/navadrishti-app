import { getServerSupabaseClient } from "@/lib/supabase-server";
import {
  evaluateFieldOfficerSession,
  type FieldOfficerIdentityRow,
} from "@/lib/field-officer-auth";
import type { AppSession } from "@/lib/session";

export type FieldOfficerProjectAccess =
  | {
      ok: true;
      session: AppSession;
      identity: FieldOfficerIdentityRow;
      projectIds: string[];
    }
  | { ok: false; status: 401 | 403; error: string; code?: string };

/**
 * Revalidate FO session + parent NGO identity, then return active assigned project IDs.
 */
export async function resolveFieldOfficerAssignedProjects(
  session: AppSession,
  options: { allowPasswordChangePending?: boolean } = {}
): Promise<FieldOfficerProjectAccess> {
  const evaluation = await evaluateFieldOfficerSession(session, {
    allowPasswordChangePending: options.allowPasswordChangePending,
  });
  if (!evaluation.ok) {
    return {
      ok: false,
      status: evaluation.status,
      error: evaluation.error,
      code: "field_officer_session",
    };
  }

  const supabase = getServerSupabaseClient();
  const { data, error } = await supabase
    .from("ngo_field_officer_project_assignments")
    .select("project_id, status, ngo_user_id")
    .eq("field_officer_identity_id", evaluation.identity.id)
    .eq("field_officer_user_id", evaluation.identity.user_id)
    .eq("ngo_user_id", evaluation.identity.ngo_user_id)
    .eq("status", "active");

  if (error) throw error;

  const projectIds = (data ?? [])
    .map((row) => String(row.project_id || "").trim())
    .filter(Boolean);

  return {
    ok: true,
    session: evaluation.session,
    identity: evaluation.identity,
    projectIds,
  };
}

/**
 * Assert the authenticated Field Officer has an active assignment to projectId
 * and that the project still belongs to the parent NGO.
 */
export async function assertFieldOfficerAssignedToProject(
  session: AppSession,
  projectId: string,
  options: { allowPasswordChangePending?: boolean } = {}
): Promise<
  | { ok: true; session: AppSession; identity: FieldOfficerIdentityRow }
  | { ok: false; status: 401 | 403 | 404; error: string; code?: string }
> {
  const access = await resolveFieldOfficerAssignedProjects(session, options);
  if (!access.ok) return access;

  const normalizedProjectId = String(projectId || "").trim();
  if (!normalizedProjectId) {
    return { ok: false, status: 404, error: "Project not found." };
  }

  if (!access.projectIds.includes(normalizedProjectId)) {
    return { ok: false, status: 403, error: "This project is not assigned to your account." };
  }

  const supabase = getServerSupabaseClient();
  const { data: project, error } = await supabase
    .from("csr_projects")
    .select("id, ngo_user_id")
    .eq("id", normalizedProjectId)
    .maybeSingle();

  if (error) throw error;
  if (!project) {
    return { ok: false, status: 404, error: "Project not found." };
  }

  if (Number(project.ngo_user_id) !== access.identity.ngo_user_id) {
    return { ok: false, status: 403, error: "This project is not assigned to your account." };
  }

  return {
    ok: true,
    session: access.session,
    identity: access.identity,
  };
}
