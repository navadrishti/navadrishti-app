import { describe, expect, it } from "vitest";
import { isActiveAssignmentStatus, isHistoryAssignmentStatus } from "@/lib/attendance";

describe("assignment attendance status allowlist", () => {
  it.each([
    ["active", true],
    ["in_progress", true],
    ["ACTIVE", true],
    ["In_Progress", true],
  ])("allows marking for %s", (status, allowed) => {
    expect(isActiveAssignmentStatus(status)).toBe(allowed);
  });

  it.each(["pending", "assigned", "paused", "completed", "cancelled", "canceled", "", null, undefined])(
    "refuses marking for %s",
    (status) => {
      expect(isActiveAssignmentStatus(status)).toBe(false);
    }
  );

  it.each(["completed", "cancelled", "canceled", "finished", "closed", "done", "expired"])(
    "treats %s as history",
    (status) => {
      expect(isHistoryAssignmentStatus(status)).toBe(true);
    }
  );

  it.each(["pending", "assigned", "paused", "active", "in_progress"])(
    "does not treat %s as history",
    (status) => {
      expect(isHistoryAssignmentStatus(status)).toBe(false);
    }
  );
});
