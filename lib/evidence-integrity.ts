import crypto from "node:crypto";

/** SHA-256 hex digest of raw media bytes (server-authoritative content seal). */
export function hashMediaBytes(buffer: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Deterministic JSON for hashing. PostgreSQL jsonb reorders object keys; unstable
 * JSON.stringify(order) would make historical verification fail after round-trip.
 * Arrays keep order; object keys are sorted recursively.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(stabilize(value));
}

function stabilize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stabilize);
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    out[key] = stabilize(input[key]);
  }
  return out;
}

/**
 * Canonical event-chain hash for field_events.payload_hash (evidence-chain-v1).
 * Includes previous chain tip + sealed metadata + media content digests.
 * Does not claim Cloudinary CDN immutability — seals bytes observed at ingest.
 *
 * Integrity model (honest scope):
 * - Each accepted submission links to the server tip at insert time (`prev_hash`).
 * - Historical verification recomputes this same function over stored jsonb payloads.
 * - Concurrent appends that race the same tip are blocked by field_events_entity_prev_hash_uidx.
 *
 * Note: Events sealed with a pre-canonical JSON.stringify (key-order dependent) will not
 * verify against jsonb round-trips; treat those as a migration/re-seal concern.
 */
export function calculateEvidenceChainHash(input: {
  prevHash: string | null;
  sealedData: unknown;
  mediaContentHashes: string[];
}): string {
  const mediaContentHashes = [...input.mediaContentHashes].map(String).sort();
  const dataToHash = stableStringify({
    prev_hash: input.prevHash,
    media_content_hashes: mediaContentHashes,
    data: input.sealedData,
  });
  return crypto.createHash("sha256").update(dataToHash).digest("hex");
}

/**
 * When the client supplies per-file proof hashes (same order as multipart files),
 * require an exact match against server-computed digests.
 */
export function assertClientMediaProofs(
  clientProofs: unknown,
  serverHashes: string[]
): string | null {
  if (clientProofs === undefined || clientProofs === null) return null;
  if (!Array.isArray(clientProofs)) {
    return "media_proof_hashes must be an array of SHA-256 hex digests.";
  }
  if (clientProofs.length !== serverHashes.length) {
    return "media_proof_hashes count must match uploaded files.";
  }
  for (let i = 0; i < serverHashes.length; i++) {
    const provided = String(clientProofs[i] || "")
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(provided)) {
      return "Each media_proof_hash must be a SHA-256 hex digest.";
    }
    if (provided !== serverHashes[i]) {
      return "Uploaded media does not match the declared content hash.";
    }
  }
  return null;
}

/**
 * Optional optimistic concurrency: when the client declares the tip it built against,
 * reject if the server tip has moved (offline sync should retry with the new tip).
 * Omitted / empty claimed tips are allowed for backward-compatible offline clients.
 */
export function assertExpectedPrevHash(
  claimed: unknown,
  serverTip: string | null
): string | null {
  if (claimed === undefined || claimed === null || claimed === "") return null;

  const raw = String(claimed).trim().toLowerCase();
  if (raw === "null" || raw === "genesis" || raw === "none") {
    if (serverTip !== null) {
      return "expected_prev_hash does not match the current chain tip.";
    }
    return null;
  }

  if (!/^[a-f0-9]{64}$/.test(raw)) {
    return "expected_prev_hash must be a SHA-256 hex digest (or null for genesis).";
  }

  if ((serverTip || "").toLowerCase() !== raw) {
    return "expected_prev_hash does not match the current chain tip.";
  }
  return null;
}

/** Sentinel used in unique indexes when prev_hash is null (Postgres UNIQUE allows many NULLs). */
export const GENESIS_PREV_HASH_SENTINEL = "";

export function chainPrevKey(prevHash: string | null): string {
  return prevHash ?? GENESIS_PREV_HASH_SENTINEL;
}
