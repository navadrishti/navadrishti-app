import { describe, expect, it } from "vitest";
import {
  evidenceImmutableHash,
  evidenceMediaType,
  isLockedMilestoneStatus,
  isTerminalSyncStatus,
  validateEvidenceFiles,
} from "@/lib/evidence-rules";
import { getAccountAccessBlockReason } from "@/lib/account-access";
import { AttendanceError, attendanceErrorStatus } from "@/lib/attendance";

describe("milestone evidence rules", () => {
  it("locks approved and completed milestones only, matching the platform", () => {
    expect(isLockedMilestoneStatus("approved")).toBe(true);
    expect(isLockedMilestoneStatus("Completed")).toBe(true);
    for (const status of ["pending", "submitted", "rejected", "", null]) {
      expect(isLockedMilestoneStatus(status)).toBe(false);
    }
  });

  it("accepts photos, videos and PDFs but rejects SVG and unknown types", () => {
    expect(evidenceMediaType("image/jpeg")).toBe("image");
    expect(evidenceMediaType("video/mp4")).toBe("video");
    expect(evidenceMediaType("application/pdf")).toBe("document");
    expect(evidenceMediaType("image/svg+xml")).toBeNull();
    expect(evidenceMediaType("text/html")).toBeNull();
  });

  it("limits file count and size", () => {
    expect(validateEvidenceFiles([{ type: "image/jpeg", size: 1000 }])).toBeNull();
    expect(validateEvidenceFiles(Array.from({ length: 11 }, () => ({ type: "image/jpeg", size: 1 })))).toMatch(/at most 10/);
    expect(validateEvidenceFiles([{ type: "image/jpeg", size: 26 * 1024 * 1024 }])).toMatch(/25 MB/);
    expect(validateEvidenceFiles([{ type: "image/svg+xml", size: 10 }])).toMatch(/photos, videos and PDF/);
  });

  it("derives the evidence dedupe key from the capture's event id", () => {
    expect(evidenceImmutableHash("rec-1")).toBe("field_event:rec-1");
  });

  it("stops retrying only on refusals, not on server errors or session expiry", () => {
    for (const status of [400, 403, 404, 413, 422]) expect(isTerminalSyncStatus(status)).toBe(true);
    for (const status of [401, 409, 500, 502, 503]) expect(isTerminalSyncStatus(status)).toBe(false);
  });
});

describe("account access", () => {
  it("blocks suspended, banned and temporarily locked accounts", () => {
    expect(getAccountAccessBlockReason({ account_status: "suspended" })).toMatch(/suspended/);
    expect(getAccountAccessBlockReason({ account_status: "banned" })).toMatch(/banned/);
    expect(getAccountAccessBlockReason({ account_status: "deactivated" })).toMatch(/banned/);
    expect(
      getAccountAccessBlockReason({ profile_data: { admin_moderation: { permanently_banned: true } } })
    ).toMatch(/banned/);
    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect(getAccountAccessBlockReason({ account_status: "active", locked_until: later })).toMatch(/suspended until/);
    expect(
      getAccountAccessBlockReason({ profile_data: JSON.stringify({ admin_moderation: { suspended_until: later } }) })
    ).toMatch(/suspended until/);
  });

  it("allows active accounts and expired locks", () => {
    const earlier = new Date(Date.now() - 86_400_000).toISOString();
    expect(getAccountAccessBlockReason({ account_status: "active" })).toBeNull();
    expect(getAccountAccessBlockReason({ account_status: "active", locked_until: earlier })).toBeNull();
  });
});

describe("attendance error statuses", () => {
  it("uses the explicit status of typed errors", () => {
    expect(attendanceErrorStatus(new AttendanceError("This assignment is closed", 422))).toBe(422);
    expect(attendanceErrorStatus(new AttendanceError("Assignment not found", 404))).toBe(404);
  });

  it("treats unknown failures as retryable server errors", () => {
    expect(attendanceErrorStatus(new Error("connection reset"))).toBe(500);
    expect(attendanceErrorStatus("boom")).toBe(500);
  });
});
