import { describe, expect, it } from "vitest";
import { calculateEvidenceChainHash, hashMediaBytes } from "@/lib/evidence-integrity";
import {
  extractMediaContentHashes,
  verifyEvidenceChainSnapshot,
  verifyEvidenceChainSnapshotAsync,
  type FieldEventRow,
} from "@/lib/evidence-chain-verify";

function makePayload(mediaHashes: string[], extra: Record<string, unknown> = {}) {
  return {
    notes: "synthetic",
    media_content_hashes: mediaHashes,
    media: mediaHashes.map((h, i) => ({
      url: `https://res.cloudinary.com/demo/image/upload/f${i}.jpg`,
      content_sha256: h,
    })),
    ...extra,
  };
}

function event(partial: {
  event_id: string;
  entity_id?: string;
  prev_hash: string | null;
  payload: unknown;
  mediaHashes: string[];
  id?: string;
}): FieldEventRow {
  const payload_hash = calculateEvidenceChainHash({
    prevHash: partial.prev_hash,
    sealedData: partial.payload,
    mediaContentHashes: partial.mediaHashes,
  });
  return {
    id: partial.id || partial.event_id,
    event_id: partial.event_id,
    event_type: "EVIDENCE_SUBMITTED",
    entity_id: partial.entity_id || "ent-1",
    payload: partial.payload,
    payload_hash,
    prev_hash: partial.prev_hash,
    user_id: "ngo@example.org",
    ngo_id: 7,
    device_id: "dev",
    timestamp: new Date().toISOString(),
  };
}

describe("extractMediaContentHashes", () => {
  it("reads media_content_hashes", () => {
    expect(extractMediaContentHashes({ media_content_hashes: ["aa"] })).toEqual(["aa"]);
  });
});

describe("verifyEvidenceChainSnapshot", () => {
  it("accepts a valid chain", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const p1 = makePayload(h1);
    const e1 = event({ event_id: "e1", prev_hash: null, payload: p1, mediaHashes: h1 });
    const h2 = [hashMediaBytes(Buffer.from("b"))];
    const p2 = makePayload(h2);
    const e2 = event({ event_id: "e2", prev_hash: e1.payload_hash, payload: p2, mediaHashes: h2 });
    const result = verifyEvidenceChainSnapshot("ent-1", [e1, e2]);
    expect(result.status).toBe("VALID");
    expect(result.verified_event_count).toBe(2);
    expect(result.verified_tip_hash).toBe(e2.payload_hash);
  });

  it("documents empty chain as VALID with warning", () => {
    const result = verifyEvidenceChainSnapshot("ent-empty", []);
    expect(result.status).toBe("VALID");
    expect(result.warnings.some((w) => w.category === "EMPTY_CHAIN")).toBe(true);
  });

  it("detects modified payload", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    const tampered = { ...e1, payload: makePayload(h1, { notes: "tampered" }) };
    const result = verifyEvidenceChainSnapshot("ent-1", [tampered]);
    expect(result.status).toBe("INVALID");
    expect(result.errors.some((e) => e.category === "HASH_MISMATCH")).toBe(true);
  });

  it("detects modified hash with next still pointing at old tip", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    const h2 = [hashMediaBytes(Buffer.from("b"))];
    const e2 = event({
      event_id: "e2",
      prev_hash: e1.payload_hash,
      payload: makePayload(h2),
      mediaHashes: h2,
    });
    const forged = { ...e1, payload_hash: "f".repeat(64) };
    const result = verifyEvidenceChainSnapshot("ent-1", [forged, e2]);
    expect(result.status).toBe("INVALID");
    expect(
      result.errors.some((e) => e.category === "BROKEN_LINK" || e.category === "HASH_MISMATCH")
    ).toBe(true);
  });

  it("detects broken previous-hash link", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    const h2 = [hashMediaBytes(Buffer.from("b"))];
    const e2 = event({
      event_id: "e2",
      prev_hash: "a".repeat(64),
      payload: makePayload(h2),
      mediaHashes: h2,
    });
    const result = verifyEvidenceChainSnapshot("ent-1", [e1, e2]);
    expect(result.status).toBe("INVALID");
    expect(result.errors.some((e) => e.category === "BROKEN_LINK")).toBe(true);
  });

  it("detects missing middle event (orphan tip)", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    const h2 = [hashMediaBytes(Buffer.from("b"))];
    const e2 = event({
      event_id: "e2",
      prev_hash: e1.payload_hash,
      payload: makePayload(h2),
      mediaHashes: h2,
    });
    const h3 = [hashMediaBytes(Buffer.from("c"))];
    const e3 = event({
      event_id: "e3",
      prev_hash: e2.payload_hash,
      payload: makePayload(h3),
      mediaHashes: h3,
    });
    const result = verifyEvidenceChainSnapshot("ent-1", [e1, e3]);
    expect(result.status).toBe("INVALID");
    expect(
      result.errors.some((e) => e.category === "BROKEN_LINK" || e.category === "MISSING_EVENT")
    ).toBe(true);
  });

  it("detects multiple genesis events", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    const h2 = [hashMediaBytes(Buffer.from("b"))];
    const e2 = event({ event_id: "e2", prev_hash: null, payload: makePayload(h2), mediaHashes: h2 });
    const result = verifyEvidenceChainSnapshot("ent-1", [e1, e2]);
    expect(result.status).toBe("INVALID");
    expect(result.errors.some((e) => e.category === "MULTIPLE_GENESIS")).toBe(true);
  });

  it("detects multiple tips", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    const h2 = [hashMediaBytes(Buffer.from("b"))];
    const e2 = event({
      event_id: "e2",
      prev_hash: e1.payload_hash,
      payload: makePayload(h2),
      mediaHashes: h2,
    });
    const h3 = [hashMediaBytes(Buffer.from("c"))];
    // Force same prev as e2 without being linked — need different prev that still exists
    // Create sibling by cloning prev of e2 (duplicate position also fires)
    const e3 = event({
      event_id: "e3",
      prev_hash: e1.payload_hash,
      payload: makePayload(h3),
      mediaHashes: h3,
    });
    const result = verifyEvidenceChainSnapshot("ent-1", [e1, e2, e3]);
    expect(result.status).toBe("INVALID");
    expect(
      result.errors.some(
        (e) => e.category === "MULTIPLE_TIPS" || e.category === "DUPLICATE_PREV_POSITION"
      )
    ).toBe(true);
  });

  it("detects duplicate previous-hash positions", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    const h2 = [hashMediaBytes(Buffer.from("b"))];
    const e2 = event({
      event_id: "e2",
      prev_hash: e1.payload_hash,
      payload: makePayload(h2),
      mediaHashes: h2,
    });
    const h3 = [hashMediaBytes(Buffer.from("c"))];
    const e3 = event({
      event_id: "e3",
      prev_hash: e1.payload_hash,
      payload: makePayload(h3),
      mediaHashes: h3,
    });
    const result = verifyEvidenceChainSnapshot("ent-1", [e1, e2, e3]);
    expect(result.errors.some((e) => e.category === "DUPLICATE_PREV_POSITION")).toBe(true);
  });

  it("detects invalid genesis previous hash", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({
      event_id: "e1",
      prev_hash: "b".repeat(64),
      payload: makePayload(h1),
      mediaHashes: h1,
    });
    const result = verifyEvidenceChainSnapshot("ent-1", [e1]);
    expect(result.status).toBe("INVALID");
    expect(
      result.errors.some((e) => e.category === "INVALID_GENESIS" || e.category === "BROKEN_LINK")
    ).toBe(true);
  });

  it("detects media digest mismatch inside sealed payload", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const payload = makePayload(h1);
    payload.media[0].content_sha256 = "0".repeat(64);
    const e1 = event({ event_id: "e1", prev_hash: null, payload, mediaHashes: h1 });
    // hash was computed with h1 list but media array disagrees
    const result = verifyEvidenceChainSnapshot("ent-1", [e1]);
    expect(result.status).toBe("INVALID");
    expect(result.errors.some((e) => e.category === "MEDIA_DIGEST_MISMATCH")).toBe(true);
  });

  it("returns UNSUPPORTED_FORMAT for non-sha256 payload_hash", () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    e1.payload_hash = "not-a-hash";
    const result = verifyEvidenceChainSnapshot("ent-1", [e1]);
    expect(result.status).toBe("UNSUPPORTED_FORMAT");
  });

  it("reports MEDIA_NOT_RECHECKED when byte recheck requested without fetcher", async () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    const result = await verifyEvidenceChainSnapshotAsync("ent-1", [e1], {
      recheckMediaBytes: true,
    });
    expect(result.status).toBe("VALID");
    expect(result.media_verification_status).toBe("MEDIA_NOT_RECHECKED");
  });

  it("detects media byte mismatch via fetcher", async () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    const result = await verifyEvidenceChainSnapshotAsync("ent-1", [e1], {
      recheckMediaBytes: true,
      fetchMediaBytes: async () => ({ ok: true, bytes: Buffer.from("other") }),
    });
    expect(result.status).toBe("INVALID");
    expect(result.media_verification_status).toBe("BYTES_MISMATCH");
  });

  it("warns when media bytes unavailable", async () => {
    const h1 = [hashMediaBytes(Buffer.from("a"))];
    const e1 = event({ event_id: "e1", prev_hash: null, payload: makePayload(h1), mediaHashes: h1 });
    const result = await verifyEvidenceChainSnapshotAsync("ent-1", [e1], {
      recheckMediaBytes: true,
      fetchMediaBytes: async () => ({ ok: false, reason: "unavailable" }),
    });
    expect(result.status).toBe("VALID");
    expect(result.media_verification_status).toBe("BYTES_UNAVAILABLE");
  });
});
