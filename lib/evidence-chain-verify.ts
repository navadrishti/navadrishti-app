import { calculateEvidenceChainHash, hashMediaBytes } from "@/lib/evidence-integrity";

/** Authoritative ingest algorithm (must stay aligned with POST /api/evidence). */
export const EVIDENCE_HASH_ALGORITHM = "sha256";
export const EVIDENCE_VERIFICATION_VERSION = "evidence-chain-v1";
export const EVIDENCE_CHAIN_MAX_EVENTS = 5_000;
export const EVIDENCE_MEDIA_RECHECK_MAX_BYTES = 25 * 1024 * 1024;
export const EVIDENCE_MEDIA_RECHECK_TIMEOUT_MS = 15_000;

export type EvidenceChainStatus =
  | "VALID"
  | "INVALID"
  | "INCOMPLETE"
  | "UNSUPPORTED_FORMAT"
  | "ERROR";

export type EvidenceChainErrorCategory =
  | "HASH_MISMATCH"
  | "BROKEN_LINK"
  | "MISSING_EVENT"
  | "MULTIPLE_GENESIS"
  | "MULTIPLE_TIPS"
  | "DUPLICATE_PREV_POSITION"
  | "INVALID_GENESIS"
  | "MALFORMED_EVENT"
  | "MEDIA_DIGEST_MISMATCH"
  | "UNSUPPORTED_HASH"
  | "EMPTY_CHAIN"
  | "LIMIT_EXCEEDED"
  | "INTERNAL";

export type MediaVerificationStatus =
  | "NOT_REQUESTED"
  | "SEALED_DIGESTS_OK"
  | "MEDIA_NOT_RECHECKED"
  | "BYTES_VERIFIED"
  | "BYTES_MISMATCH"
  | "BYTES_UNAVAILABLE"
  | "SKIPPED_NO_MEDIA";

export type FieldEventRow = {
  id: string;
  event_id: string;
  event_type: string;
  entity_id: string;
  payload: unknown;
  payload_hash: string;
  prev_hash: string | null;
  user_id: string;
  ngo_id: number | string;
  device_id: string;
  timestamp: string | Date;
};

export type EvidenceChainIssue = {
  category: EvidenceChainErrorCategory;
  event_id?: string;
  message: string;
  expected?: string | null;
  actual?: string | null;
};

export type EvidenceChainVerifyResult = {
  status: EvidenceChainStatus;
  entity_id: string;
  verified_event_count: number;
  verified_tip_hash: string | null;
  verified_at: string;
  snapshot_consistent: boolean;
  hash_algorithm: typeof EVIDENCE_HASH_ALGORITHM;
  verification_version: typeof EVIDENCE_VERIFICATION_VERSION;
  errors: EvidenceChainIssue[];
  warnings: EvidenceChainIssue[];
  media_verification_status: MediaVerificationStatus;
};

export type MediaByteFetcher = (url: string) => Promise<
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "unavailable" | "untrusted" | "too_large" | "timeout" | "error" }
>;

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Extract media digests sealed at ingest (same inputs used by calculateEvidenceChainHash). */
export function extractMediaContentHashes(payload: unknown): string[] | null {
  const row = asRecord(payload);
  if (!row) return null;
  if (Array.isArray(row.media_content_hashes)) {
    return row.media_content_hashes.map(String);
  }
  if (Array.isArray(row.media)) {
    const hashes: string[] = [];
    for (const item of row.media) {
      const media = asRecord(item);
      if (!media) return null;
      if (typeof media.content_sha256 === "string") hashes.push(media.content_sha256);
      else return null;
    }
    return hashes;
  }
  return [];
}

export function isTrustedCloudinaryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return (
      parsed.hostname === "res.cloudinary.com" ||
      parsed.hostname.endsWith(".cloudinary.com")
    );
  } catch {
    return false;
  }
}

function emptyResult(
  entityId: string,
  status: EvidenceChainStatus,
  extras: Partial<EvidenceChainVerifyResult> = {}
): EvidenceChainVerifyResult {
  return {
    status,
    entity_id: entityId,
    verified_event_count: 0,
    verified_tip_hash: null,
    verified_at: new Date().toISOString(),
    snapshot_consistent: true,
    hash_algorithm: EVIDENCE_HASH_ALGORITHM,
    verification_version: EVIDENCE_VERIFICATION_VERSION,
    errors: [],
    warnings: [],
    media_verification_status: "NOT_REQUESTED",
    ...extras,
  };
}

/**
 * Verify an in-memory snapshot of field_events for one entity.
 * Ordering is by hash links (not client timestamps). Timestamps are not trusted for integrity.
 */
export function verifyEvidenceChainSnapshot(
  entityId: string,
  events: FieldEventRow[],
  options: {
    recheckMediaBytes?: boolean;
    fetchMediaBytes?: MediaByteFetcher;
    maxEvents?: number;
    snapshotConsistent?: boolean;
  } = {}
): EvidenceChainVerifyResult {
  const maxEvents = options.maxEvents ?? EVIDENCE_CHAIN_MAX_EVENTS;
  const errors: EvidenceChainIssue[] = [];
  const warnings: EvidenceChainIssue[] = [];
  let mediaStatus: MediaVerificationStatus = options.recheckMediaBytes
    ? "MEDIA_NOT_RECHECKED"
    : "NOT_REQUESTED";

  if (events.length === 0) {
    return emptyResult(entityId, "VALID", {
      warnings: [
        {
          category: "EMPTY_CHAIN",
          message: "No events for this entity; empty chain is valid with null tip.",
        },
      ],
      media_verification_status: "SKIPPED_NO_MEDIA",
      snapshot_consistent: options.snapshotConsistent !== false,
    });
  }

  if (events.length > maxEvents) {
    return emptyResult(entityId, "ERROR", {
      verified_event_count: events.length,
      errors: [
        {
          category: "LIMIT_EXCEEDED",
          message: `Entity has ${events.length} events; limit is ${maxEvents}.`,
        },
      ],
      snapshot_consistent: options.snapshotConsistent !== false,
    });
  }

  for (const event of events) {
    if (event.entity_id !== entityId) {
      errors.push({
        category: "MALFORMED_EVENT",
        event_id: event.event_id,
        message: "Event entity_id does not match verification target.",
        expected: entityId,
        actual: event.entity_id,
      });
    }
    if (!isSha256Hex(event.payload_hash)) {
      return emptyResult(entityId, "UNSUPPORTED_FORMAT", {
        verified_event_count: events.length,
        errors: [
          {
            category: "UNSUPPORTED_HASH",
            event_id: event.event_id,
            message: "payload_hash is not a SHA-256 hex digest (evidence-chain-v1).",
            actual: String(event.payload_hash || ""),
          },
        ],
        snapshot_consistent: options.snapshotConsistent !== false,
      });
    }
    if (event.prev_hash !== null && event.prev_hash !== undefined && !isSha256Hex(event.prev_hash)) {
      return emptyResult(entityId, "UNSUPPORTED_FORMAT", {
        verified_event_count: events.length,
        errors: [
          {
            category: "UNSUPPORTED_HASH",
            event_id: event.event_id,
            message: "prev_hash is not null or a SHA-256 hex digest.",
            actual: String(event.prev_hash),
          },
        ],
        snapshot_consistent: options.snapshotConsistent !== false,
      });
    }
  }

  // Duplicate chain positions (entity_id + COALESCE(prev_hash,''))
  const prevBuckets = new Map<string, string[]>();
  for (const event of events) {
    const key = event.prev_hash ?? "";
    const list = prevBuckets.get(key) || [];
    list.push(event.event_id);
    prevBuckets.set(key, list);
  }
  for (const [key, ids] of prevBuckets) {
    if (ids.length > 1) {
      errors.push({
        category: "DUPLICATE_PREV_POSITION",
        message: `Multiple events occupy the same prev_hash position.`,
        expected: "1 event per prev_hash",
        actual: `${ids.length} events at prev=${key || "genesis"} (${ids.join(",")})`,
      });
    }
  }

  const byHash = new Map<string, FieldEventRow>();
  for (const event of events) {
    if (byHash.has(event.payload_hash.toLowerCase())) {
      errors.push({
        category: "MALFORMED_EVENT",
        event_id: event.event_id,
        message: "Duplicate payload_hash values within entity snapshot.",
        actual: event.payload_hash,
      });
    }
    byHash.set(event.payload_hash.toLowerCase(), event);
  }

  const genesis = events.filter((e) => e.prev_hash === null || e.prev_hash === undefined);
  if (genesis.length === 0) {
    errors.push({
      category: "INVALID_GENESIS",
      message: "No genesis event (prev_hash null) found.",
    });
  } else if (genesis.length > 1) {
    errors.push({
      category: "MULTIPLE_GENESIS",
      message: `Expected one genesis event; found ${genesis.length}.`,
      actual: genesis.map((g) => g.event_id).join(","),
    });
  }

  // Tips = hashes not referenced as anyone's prev_hash
  const referenced = new Set(
    events
      .map((e) => (e.prev_hash ? e.prev_hash.toLowerCase() : null))
      .filter((v): v is string => Boolean(v))
  );
  const tips = events.filter((e) => !referenced.has(e.payload_hash.toLowerCase()));
  if (events.length > 0 && tips.length === 0) {
    errors.push({
      category: "BROKEN_LINK",
      message: "Chain has a cycle or no terminal tip.",
    });
  } else if (tips.length > 1) {
    errors.push({
      category: "MULTIPLE_TIPS",
      message: `Expected one tip; found ${tips.length}.`,
      actual: tips.map((t) => t.event_id).join(","),
    });
  }

  // Walk from genesis following successor map (prev_hash → child)
  const childByPrev = new Map<string, FieldEventRow>();
  for (const event of events) {
    const key = event.prev_hash ? event.prev_hash.toLowerCase() : "";
    if (!childByPrev.has(key)) childByPrev.set(key, event);
  }

  const visited = new Set<string>();
  let cursor: FieldEventRow | undefined = genesis.length === 1 ? genesis[0] : undefined;
  let walked = 0;
  let tipHash: string | null = null;

  if (cursor) {
    // Invalid genesis if somehow prev set (filtered above) — double-check
    if (cursor.prev_hash !== null && cursor.prev_hash !== undefined) {
      errors.push({
        category: "INVALID_GENESIS",
        event_id: cursor.event_id,
        message: "Genesis event must have prev_hash null.",
        actual: String(cursor.prev_hash),
      });
    }

    while (cursor) {
      if (visited.has(cursor.id)) {
        errors.push({
          category: "BROKEN_LINK",
          event_id: cursor.event_id,
          message: "Cycle detected while walking the chain.",
        });
        break;
      }
      visited.add(cursor.id);
      walked += 1;

      const mediaHashes = extractMediaContentHashes(cursor.payload);
      if (mediaHashes === null) {
        errors.push({
          category: "MALFORMED_EVENT",
          event_id: cursor.event_id,
          message: "Payload is not an object or media digests are malformed.",
        });
      } else {
        const recomputed = calculateEvidenceChainHash({
          prevHash: cursor.prev_hash ?? null,
          sealedData: cursor.payload,
          mediaContentHashes: mediaHashes,
        });
        if (recomputed.toLowerCase() !== cursor.payload_hash.toLowerCase()) {
          errors.push({
            category: "HASH_MISMATCH",
            event_id: cursor.event_id,
            message: "Stored payload_hash does not match recomputed evidence-chain-v1 hash.",
            expected: recomputed,
            actual: cursor.payload_hash,
          });
        }

        const payload = asRecord(cursor.payload);
        if (payload && Array.isArray(payload.media) && Array.isArray(payload.media_content_hashes)) {
          const listed = (payload.media_content_hashes as unknown[])
            .map(String)
            .map((h) => h.toLowerCase())
            .sort();
          const fromMedia = payload.media
            .map((item) => asRecord(item)?.content_sha256)
            .filter((h): h is string => typeof h === "string")
            .map((h) => h.toLowerCase())
            .sort();
          if (payload.media.length > 0 && listed.join("|") !== fromMedia.join("|")) {
            errors.push({
              category: "MEDIA_DIGEST_MISMATCH",
              event_id: cursor.event_id,
              message: "media_content_hashes do not match media[].content_sha256 digests.",
            });
          }
        }

        if (!options.recheckMediaBytes) {
          if (mediaHashes.length === 0) mediaStatus = "SKIPPED_NO_MEDIA";
          else if (mediaStatus === "NOT_REQUESTED") mediaStatus = "SEALED_DIGESTS_OK";
        }
      }

      tipHash = cursor.payload_hash;
      const next = childByPrev.get(cursor.payload_hash.toLowerCase());
      cursor = next;
    }

    if (walked < events.length) {
      const orphanIds = events.filter((e) => !visited.has(e.id)).map((e) => e.event_id);
      errors.push({
        category: "MISSING_EVENT",
        message: "Not all events are reachable from genesis via prev_hash links.",
        actual: orphanIds.join(","),
      });
    }

    // Broken explicit links: prev_hash set but predecessor missing
    for (const event of events) {
      if (!event.prev_hash) continue;
      if (!byHash.has(event.prev_hash.toLowerCase())) {
        errors.push({
          category: "BROKEN_LINK",
          event_id: event.event_id,
          message: "prev_hash does not match any payload_hash in the entity snapshot.",
          expected: event.prev_hash,
          actual: null,
        });
      }
    }
  }

  if (mediaStatus === "NOT_REQUESTED" && events.length > 0) {
    mediaStatus = "SEALED_DIGESTS_OK";
  }

  const status: EvidenceChainStatus = errors.length === 0 ? "VALID" : "INVALID";
  return {
    status,
    entity_id: entityId,
    verified_event_count: events.length,
    verified_tip_hash: tips.length === 1 ? tips[0].payload_hash : tipHash,
    verified_at: new Date().toISOString(),
    snapshot_consistent: options.snapshotConsistent !== false,
    hash_algorithm: EVIDENCE_HASH_ALGORITHM,
    verification_version: EVIDENCE_VERIFICATION_VERSION,
    errors,
    warnings,
    media_verification_status: mediaStatus,
  };
}

/**
 * Same as verifyEvidenceChainSnapshot, then optionally re-download trusted media URLs.
 */
export async function verifyEvidenceChainSnapshotAsync(
  entityId: string,
  events: FieldEventRow[],
  options: {
    recheckMediaBytes?: boolean;
    fetchMediaBytes?: MediaByteFetcher;
    maxEvents?: number;
    snapshotConsistent?: boolean;
  } = {}
): Promise<EvidenceChainVerifyResult> {
  const base = verifyEvidenceChainSnapshot(entityId, events, {
    ...options,
    recheckMediaBytes: false,
  });

  if (!options.recheckMediaBytes) return base;

  if (!options.fetchMediaBytes) {
    return {
      ...base,
      media_verification_status: "MEDIA_NOT_RECHECKED",
      warnings: [
        ...base.warnings,
        {
          category: "INTERNAL",
          message:
            "Media byte recheck was requested but no trusted fetcher was provided; sealed digests were checked for internal consistency only.",
        },
      ],
    };
  }

  if (base.status !== "VALID") return base;

  const errors = [...base.errors];
  const warnings = [...base.warnings];
  let mediaStatus: MediaVerificationStatus = "BYTES_VERIFIED";
  let checked = 0;

  for (const event of events) {
    const payload = asRecord(event.payload);
    if (!payload || !Array.isArray(payload.media)) continue;
    for (const item of payload.media) {
      const media = asRecord(item);
      if (!media) continue;
      const digest = typeof media.content_sha256 === "string" ? media.content_sha256.toLowerCase() : "";
      const url = typeof media.url === "string" ? media.url : "";
      if (!digest || !url) continue;
      if (!isTrustedCloudinaryUrl(url)) {
        warnings.push({
          category: "INTERNAL",
          event_id: event.event_id,
          message: "Skipped media byte recheck for non-Cloudinary or untrusted URL.",
        });
        mediaStatus = "MEDIA_NOT_RECHECKED";
        continue;
      }
      const fetched = await options.fetchMediaBytes(url);
      checked += 1;
      if (!fetched.ok) {
        if (fetched.reason === "unavailable") {
          warnings.push({
            category: "INTERNAL",
            event_id: event.event_id,
            message: "Media bytes unavailable for recheck.",
          });
          mediaStatus = "BYTES_UNAVAILABLE";
        } else {
          warnings.push({
            category: "INTERNAL",
            event_id: event.event_id,
            message: `Media byte recheck skipped (${fetched.reason}).`,
          });
          mediaStatus = "MEDIA_NOT_RECHECKED";
        }
        continue;
      }
      const actual = hashMediaBytes(fetched.bytes);
      if (actual !== digest) {
        errors.push({
          category: "MEDIA_DIGEST_MISMATCH",
          event_id: event.event_id,
          message: "Re-downloaded media bytes do not match sealed content_sha256.",
          expected: digest,
          actual,
        });
        mediaStatus = "BYTES_MISMATCH";
      }
    }
  }

  if (checked === 0 && mediaStatus === "BYTES_VERIFIED") {
    mediaStatus = "SKIPPED_NO_MEDIA";
  }

  return {
    ...base,
    status: errors.length === 0 ? base.status : "INVALID",
    errors,
    warnings,
    media_verification_status: mediaStatus,
  };
}
