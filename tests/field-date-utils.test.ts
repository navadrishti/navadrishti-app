import { describe, expect, it } from "vitest";
import { formatDeviceDateTime, getLocalDateStringClient } from "@/lib/utils";

describe("field date helpers", () => {
  it("uses Asia/Kolkata calendar days for attendance dating", () => {
    // 2026-03-15 18:30 UTC is already 2026-03-16 morning in IST
    const lateUtc = new Date("2026-03-15T18:30:00.000Z");
    expect(getLocalDateStringClient(lateUtc)).toBe("2026-03-16");
  });

  it("formats device timestamps in a stable IST locale", () => {
    const formatted = formatDeviceDateTime("2026-03-15T10:15:00.000Z");
    expect(formatted).toMatch(/15/);
    expect(formatted).toMatch(/Mar/i);
    expect(formatted).toMatch(/2026/);
  });
});
