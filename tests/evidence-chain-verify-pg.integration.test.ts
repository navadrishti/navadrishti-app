/**
 * Local PostgreSQL integration tests for historical chain verification.
 * Requires NAVADRISHTI_PG_TEST_URL → localhost / navadrishti_cycle11_test.
 * Skipped (not passed) when unset.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { calculateEvidenceChainHash, hashMediaBytes } from "@/lib/evidence-integrity";
import { verifyEntityEvidenceChainPg } from "@/lib/evidence-chain-store";

function loadEnvLocal() {
  const envPath = path.resolve("c:/Users/chaks/Desktop/Navadrishti/.env.local");
  const alt = path.resolve(process.cwd(), ".env.local");
  for (const candidate of [envPath, alt]) {
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

// Load env before reading LIVE / ENABLED — otherwise .env.local values are invisible to the gate.
loadEnvLocal();

const url = process.env.NAVADRISHTI_PG_TEST_URL?.trim() || "";
/** True when the env var is set after local env load (may still be refused if Supabase). */
const LIVE = Boolean(url);
/** Local disposable PG only — never enable against Supabase. */
const ENABLED = LIVE && !/supabase/i.test(url);

function assertLocalUrl(raw: string) {
  const u = new URL(raw);
  if (!["localhost", "127.0.0.1", "::1"].includes(u.hostname)) {
    throw new Error(`Refusing non-local host ${u.hostname}`);
  }
  if (u.pathname.replace(/^\//, "") !== "navadrishti_cycle11_test") {
    throw new Error(`Refusing unexpected database ${u.pathname}`);
  }
}

const PREFIX = `p4_${Date.now().toString(36)}_`;

describe.skipIf(!ENABLED)("evidence chain verify (local PG)", () => {
  let pg: typeof import("pg");
  let client: import("pg").Client;

  beforeAll(async () => {
    assertLocalUrl(url);
    pg = await import("pg");
    client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    await client.connect();
    const id = await client.query("SELECT current_database() AS db, inet_server_addr()::text AS addr");
    if (id.rows[0].db !== "navadrishti_cycle11_test") throw new Error("identity fail");
    if (String(id.rows[0].addr || "").includes("supabase")) throw new Error("supabase");
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DELETE FROM public.field_events WHERE event_id LIKE $1`, [`${PREFIX}%`]);
      await client.end().catch(() => undefined);
    }
  });

  beforeEach(async () => {
    await client.query(`DELETE FROM public.field_events WHERE event_id LIKE $1`, [`${PREFIX}%`]);
  });

  async function insertEvent(input: {
    event_id: string;
    entity_id: string;
    prev_hash: string | null;
    payload: unknown;
    mediaHashes: string[];
  }) {
    const payload_hash = calculateEvidenceChainHash({
      prevHash: input.prev_hash,
      sealedData: input.payload,
      mediaContentHashes: input.mediaHashes,
    });
    await client.query(
      `INSERT INTO field_events
        (event_id, event_type, entity_id, payload, payload_hash, prev_hash, user_id, ngo_id, device_id)
       VALUES ($1,'EVIDENCE',$2,$3::jsonb,$4,$5,'test@local',7,'dev')`,
      [input.event_id, input.entity_id, JSON.stringify(input.payload), payload_hash, input.prev_hash]
    );
    return payload_hash;
  }

  function payload(hashes: string[]) {
    return {
      media_content_hashes: hashes,
      media: hashes.map((h) => ({
        url: "https://res.cloudinary.com/demo/image/upload/x.jpg",
        content_sha256: h,
      })),
    };
  }

  it("verifies a valid multi-event chain", async () => {
    const entity = `${PREFIX}ent_ok`;
    const h1 = [hashMediaBytes(Buffer.from("pg-a"))];
    const tip1 = await insertEvent({
      event_id: `${PREFIX}e1`,
      entity_id: entity,
      prev_hash: null,
      payload: payload(h1),
      mediaHashes: h1,
    });
    const h2 = [hashMediaBytes(Buffer.from("pg-b"))];
    await insertEvent({
      event_id: `${PREFIX}e2`,
      entity_id: entity,
      prev_hash: tip1,
      payload: payload(h2),
      mediaHashes: h2,
    });
    const result = await verifyEntityEvidenceChainPg(client, entity);
    expect(result.status).toBe("VALID");
    expect(result.verified_event_count).toBe(2);
    expect(result.snapshot_consistent).toBe(true);
  });

  it("detects payload tampering in the database", async () => {
    const entity = `${PREFIX}ent_tamper`;
    const h1 = [hashMediaBytes(Buffer.from("pg-t"))];
    await insertEvent({
      event_id: `${PREFIX}t1`,
      entity_id: entity,
      prev_hash: null,
      payload: payload(h1),
      mediaHashes: h1,
    });
    await client.query(
      `UPDATE field_events SET payload = payload || '{"notes":"tampered"}'::jsonb WHERE event_id = $1`,
      [`${PREFIX}t1`]
    );
    const result = await verifyEntityEvidenceChainPg(client, entity);
    expect(result.status).toBe("INVALID");
    expect(result.errors.some((e) => e.category === "HASH_MISMATCH")).toBe(true);
  });

  it("detects broken link after privileged hash rewrite", async () => {
    const entity = `${PREFIX}ent_break`;
    const h1 = [hashMediaBytes(Buffer.from("1"))];
    const tip1 = await insertEvent({
      event_id: `${PREFIX}b1`,
      entity_id: entity,
      prev_hash: null,
      payload: payload(h1),
      mediaHashes: h1,
    });
    const h2 = [hashMediaBytes(Buffer.from("2"))];
    await insertEvent({
      event_id: `${PREFIX}b2`,
      entity_id: entity,
      prev_hash: tip1,
      payload: payload(h2),
      mediaHashes: h2,
    });
    await client.query(`UPDATE field_events SET payload_hash = $1 WHERE event_id = $2`, [
      "c".repeat(64),
      `${PREFIX}b1`,
    ]);
    const result = await verifyEntityEvidenceChainPg(client, entity);
    expect(result.status).toBe("INVALID");
  });

  it("returns VALID empty chain", async () => {
    const result = await verifyEntityEvidenceChainPg(client, `${PREFIX}missing`);
    expect(result.status).toBe("VALID");
    expect(result.verified_event_count).toBe(0);
  });

  it("keeps a consistent snapshot while a concurrent append commits after verification starts", async () => {
    const entity = `${PREFIX}ent_conc`;
    const h1 = [hashMediaBytes(Buffer.from("c1"))];
    const tip1 = await insertEvent({
      event_id: `${PREFIX}c1`,
      entity_id: entity,
      prev_hash: null,
      payload: payload(h1),
      mediaHashes: h1,
    });

    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const during = await verifyEntityEvidenceChainPg(client, entity, { alreadyInTransaction: true });

    const writer = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    await writer.connect();
    const h2 = [hashMediaBytes(Buffer.from("c2"))];
    const tip2 = calculateEvidenceChainHash({
      prevHash: tip1,
      sealedData: payload(h2),
      mediaContentHashes: h2,
    });
    await writer.query(
      `INSERT INTO field_events
        (event_id, event_type, entity_id, payload, payload_hash, prev_hash, user_id, ngo_id, device_id)
       VALUES ($1,'EVIDENCE',$2,$3::jsonb,$4,$5,'test@local',7,'dev')`,
      [`${PREFIX}c2`, entity, JSON.stringify(payload(h2)), tip2, tip1]
    );
    await writer.end();

    expect(during.status).toBe("VALID");
    expect(during.verified_event_count).toBe(1);
    expect(during.verified_tip_hash).toBe(tip1);
    expect(during.snapshot_consistent).toBe(true);
    await client.query("COMMIT");

    const after = await verifyEntityEvidenceChainPg(client, entity);
    expect(after.verified_event_count).toBe(2);
  });

  it("verifies a larger paginated history", async () => {
    const entity = `${PREFIX}ent_big`;
    let prev: string | null = null;
    for (let i = 0; i < 25; i++) {
      const hashes = [hashMediaBytes(Buffer.from(`row-${i}`))];
      prev = await insertEvent({
        event_id: `${PREFIX}big_${i}`,
        entity_id: entity,
        prev_hash: prev,
        payload: payload(hashes),
        mediaHashes: hashes,
      });
    }
    const result = await verifyEntityEvidenceChainPg(client, entity);
    expect(result.status).toBe("VALID");
    expect(result.verified_event_count).toBe(25);
  });
});

describe("evidence chain PG gate", () => {
  it("skips live suite when unset, and refuses Supabase URLs without enabling", () => {
    if (!url) {
      expect(LIVE).toBe(false);
      expect(ENABLED).toBe(false);
      return;
    }
    if (/supabase/i.test(url)) {
      expect(LIVE).toBe(true);
      expect(ENABLED).toBe(false);
      return;
    }
    expect(ENABLED).toBe(true);
  });
});
