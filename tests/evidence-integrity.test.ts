import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertClientMediaProofs,
  assertExpectedPrevHash,
  calculateEvidenceChainHash,
  hashMediaBytes,
} from "@/lib/evidence-integrity";

describe("evidence integrity helpers", () => {
  it("hashes media bytes with SHA-256", () => {
    const buf = Buffer.from("abcd");
    expect(hashMediaBytes(buf)).toBe(createHash("sha256").update(buf).digest("hex"));
  });

  it("changes chain hash when media content changes", () => {
    const base = {
      prevHash: "abc",
      sealedData: { notes: "ok" },
      mediaContentHashes: [hashMediaBytes(Buffer.from("one"))],
    };
    const a = calculateEvidenceChainHash(base);
    const b = calculateEvidenceChainHash({
      ...base,
      mediaContentHashes: [hashMediaBytes(Buffer.from("two"))],
    });
    expect(a).not.toBe(b);
  });

  it("changes chain hash when prev_hash changes", () => {
    const hashes = [hashMediaBytes(Buffer.from("img"))];
    const a = calculateEvidenceChainHash({ prevHash: null, sealedData: {}, mediaContentHashes: hashes });
    const b = calculateEvidenceChainHash({ prevHash: "tip", sealedData: {}, mediaContentHashes: hashes });
    expect(a).not.toBe(b);
  });

  it("rejects mismatched client media proofs", () => {
    const server = [hashMediaBytes(Buffer.from("file"))];
    expect(assertClientMediaProofs(["0".repeat(64)], server)).toMatch(/does not match/i);
  });

  it("accepts matching client media proofs", () => {
    const server = [hashMediaBytes(Buffer.from("file"))];
    expect(assertClientMediaProofs(server, server)).toBeNull();
  });

  it("allows omitting client media proofs (server-only seal)", () => {
    expect(assertClientMediaProofs(undefined, ["abc"])).toBeNull();
  });

  it("accepts matching expected_prev_hash and genesis sentinels", () => {
    expect(assertExpectedPrevHash(undefined, "tip")).toBeNull();
    expect(assertExpectedPrevHash("null", null)).toBeNull();
    expect(assertExpectedPrevHash("a".repeat(64), "a".repeat(64))).toBeNull();
  });

  it("rejects mismatched or malformed expected_prev_hash", () => {
    expect(assertExpectedPrevHash("null", "tip")).toMatch(/chain tip/i);
    expect(assertExpectedPrevHash("not-a-hash", null)).toMatch(/SHA-256/i);
    expect(assertExpectedPrevHash("a".repeat(64), "b".repeat(64))).toMatch(/chain tip/i);
  });
});
