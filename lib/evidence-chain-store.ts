import type { FieldEventRow } from "@/lib/evidence-chain-verify";
import {
  EVIDENCE_CHAIN_MAX_EVENTS,
  verifyEvidenceChainSnapshotAsync,
  type EvidenceChainVerifyResult,
  type MediaByteFetcher,
} from "@/lib/evidence-chain-verify";

export type SqlQueryable = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

const PAGE_SIZE = 500;

/**
 * Load all field_events for an entity inside the caller's open transaction.
 * Uses keyset pagination on (timestamp ASC, id ASC) — deterministic, not trusted for hash links.
 * Caller must BEGIN … ISOLATION LEVEL REPEATABLE READ before invoking.
 */
export async function loadEntityEventsInTransaction(
  client: SqlQueryable,
  entityId: string,
  maxEvents = EVIDENCE_CHAIN_MAX_EVENTS
): Promise<FieldEventRow[]> {
  const events: FieldEventRow[] = [];
  let lastTs: string | null = null;
  let lastId: string | null = null;

  while (events.length <= maxEvents) {
    const params: unknown[] = [entityId, PAGE_SIZE];
    let sql = `
      SELECT id, event_id, event_type, entity_id, payload, payload_hash, prev_hash,
             user_id, ngo_id, device_id, timestamp
      FROM public.field_events
      WHERE entity_id = $1
    `;
    if (lastTs && lastId) {
      params.push(lastTs, lastId);
      sql += ` AND (timestamp, id) > ($3::timestamptz, $4::uuid)`;
    }
    sql += ` ORDER BY timestamp ASC, id ASC LIMIT $2`;

    const { rows } = await client.query(sql, params);
    if (rows.length === 0) break;

    for (const row of rows) {
      events.push({
        id: String(row.id),
        event_id: String(row.event_id),
        event_type: String(row.event_type),
        entity_id: String(row.entity_id),
        payload: row.payload,
        payload_hash: String(row.payload_hash),
        prev_hash: row.prev_hash === null || row.prev_hash === undefined ? null : String(row.prev_hash),
        user_id: String(row.user_id),
        ngo_id: row.ngo_id as number | string,
        device_id: String(row.device_id),
        timestamp: row.timestamp as string | Date,
      });
    }

    if (rows.length < PAGE_SIZE) break;
    const last = rows[rows.length - 1];
    lastTs = new Date(last.timestamp as string | Date).toISOString();
    lastId = String(last.id);
    if (events.length > maxEvents) break;
  }

  return events;
}

/**
 * Historical verification against PostgreSQL using REPEATABLE READ snapshot.
 * All pages share the same transaction so concurrent appends cannot tear the view.
 */
export async function verifyEntityEvidenceChainPg(
  client: SqlQueryable & {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  },
  entityId: string,
  options: {
    recheckMediaBytes?: boolean;
    fetchMediaBytes?: MediaByteFetcher;
    maxEvents?: number;
    /** When true, caller already opened a RR transaction. */
    alreadyInTransaction?: boolean;
  } = {}
): Promise<EvidenceChainVerifyResult> {
  const run = async () => {
    const events = await loadEntityEventsInTransaction(
      client,
      entityId,
      options.maxEvents ?? EVIDENCE_CHAIN_MAX_EVENTS
    );
    return verifyEvidenceChainSnapshotAsync(entityId, events, {
      recheckMediaBytes: options.recheckMediaBytes,
      fetchMediaBytes: options.fetchMediaBytes,
      maxEvents: options.maxEvents,
      snapshotConsistent: true,
    });
  };

  if (options.alreadyInTransaction) return run();

  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    const result = await run();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
