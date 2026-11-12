import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { findAccountBlockReason } from "@/lib/account-access";
import {
  EVIDENCE_CHAIN_MAX_EVENTS,
  verifyEvidenceChainSnapshotAsync,
  type FieldEventRow,
} from "@/lib/evidence-chain-verify";

export const runtime = "nodejs";

const PAGE_SIZE = 500;

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

/**
 * Server-side historical chain verification for one entity_id.
 * Does not accept client-supplied hashes or tips as proof.
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  if (!session) return fail("Authentication required.", 401);
  if (session.role !== "ngo") return fail("Evidence verification is available for NGO accounts.", 403);

  const ngoId = Number(session.ngoId);
  const blockReason = await findAccountBlockReason(ngoId);
  if (blockReason) return fail(blockReason, 403);

  let body: { entity_id?: unknown; recheck_media_bytes?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail("Request body must be JSON.", 400);
  }

  const entityId = String(body.entity_id || "").trim();
  if (!entityId || entityId.length > 128) {
    return fail("entity_id is required.", 400);
  }

  const recheckMediaBytes = body.recheck_media_bytes === true;
  const supabase = getServerSupabaseClient();

  // Authorize: at least one event for this entity must belong to the NGO,
  // or the entity must be a milestone/project owned by the NGO.
  const { data: sample, error: sampleError } = await supabase
    .from("field_events")
    .select("id, ngo_id")
    .eq("entity_id", entityId)
    .limit(1)
    .maybeSingle();
  if (sampleError) {
    console.error("[evidence/verify] sample lookup failed");
    return fail("Evidence chain could not be verified.", 500);
  }

  if (sample) {
    if (Number(sample.ngo_id) !== ngoId) {
      return fail("Entity not found.", 404);
    }
  } else {
    const { data: milestone } = await supabase
      .from("csr_project_milestones")
      .select("id, project_id")
      .eq("id", entityId)
      .maybeSingle();
    let projectId = milestone?.project_id as string | undefined;
    if (!projectId) {
      const { data: project } = await supabase
        .from("csr_projects")
        .select("id, ngo_user_id")
        .eq("id", entityId)
        .maybeSingle();
      if (!project || Number(project.ngo_user_id) !== ngoId) {
        return fail("Entity not found.", 404);
      }
    } else {
      const { data: project } = await supabase
        .from("csr_projects")
        .select("id, ngo_user_id")
        .eq("id", projectId)
        .maybeSingle();
      if (!project || Number(project.ngo_user_id) !== ngoId) {
        return fail("Entity not found.", 404);
      }
    }
  }

  // Supabase JS does not expose REPEATABLE READ; load with deterministic order
  // and document snapshot_consistent=false for this transport. PG integration
  // tests use verifyEntityEvidenceChainPg for true RR snapshots.
  const events: FieldEventRow[] = [];
  let offset = 0;
  while (events.length <= EVIDENCE_CHAIN_MAX_EVENTS) {
    const { data, error } = await supabase
      .from("field_events")
      .select(
        "id, event_id, event_type, entity_id, payload, payload_hash, prev_hash, user_id, ngo_id, device_id, timestamp"
      )
      .eq("entity_id", entityId)
      .order("timestamp", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("[evidence/verify] page load failed");
      return fail("Evidence chain could not be verified.", 500);
    }
    const page = (data || []) as FieldEventRow[];
    events.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const result = await verifyEvidenceChainSnapshotAsync(entityId, events, {
    recheckMediaBytes,
    snapshotConsistent: false,
  });

  // Strip unexpected payload leakage — result already omits raw payloads.
  return NextResponse.json({
    ok: true,
    verification: result,
    note:
      "Supabase pagination is not a PostgreSQL REPEATABLE READ snapshot. For audit-grade consistency use the local PG verifier transaction.",
  });
}
