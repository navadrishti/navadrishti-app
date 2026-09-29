import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncQueueItem } from "@/lib/types";

type Row = Record<string, any> & { id: string };

/** In-memory stand-in for the Dexie tables the sync engine touches. */
function table() {
  const rows = new Map<string, Row>();
  return {
    rows,
    get: async (id: string) => rows.get(id),
    put: async (row: Row) => void rows.set(row.id, { ...row }),
    add: async (row: Row) => void rows.set(row.id, { ...row }),
    update: async (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...patch });
    },
    delete: async (id: string) => void rows.delete(id),
    filter: (predicate: (row: Row) => boolean) => ({
      sortBy: async (key: string) =>
        [...rows.values()].filter(predicate).sort((a, b) => Number(a[key]) - Number(b[key])),
    }),
    where: (key: string) => ({
      equals: (value: unknown) => {
        const matches = () => [...rows.values()].filter((row) => row[key] === value);
        return {
          toArray: async () => matches(),
          delete: async () => matches().forEach((row) => rows.delete(row.id)),
        };
      },
    }),
  };
}

const db = {
  syncQueue: table(),
  attendanceOutbox: table(),
  recordsLocal: table(),
  mediaLocal: table(),
  syncLog: table(),
};
const apiFetch = vi.fn();

vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/env", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

vi.stubGlobal("window", { navigator: { onLine: true } });
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const { processSyncQueue } = await import("@/lib/sync-engine");

function queueItem(overrides: Partial<SyncQueueItem> = {}): SyncQueueItem {
  return {
    id: "q-1",
    recordId: "att-1",
    userId: "7",
    kind: "attendance",
    status: "pending",
    attempts: 0,
    nextAttemptAt: Date.now() - 1000,
    lastError: null,
    createdAt: "2026-09-29T09:00:00.000Z",
    updatedAt: "2026-09-29T09:00:00.000Z",
    ...overrides,
  };
}

function queueAttendance(overrides: Partial<SyncQueueItem> = {}) {
  void db.attendanceOutbox.put({
    id: "att-1",
    userId: "7",
    assignmentId: "as-1",
    attendanceDate: "2026-09-28",
    latitude: 19.1,
    longitude: 72.8,
    accuracy: null,
    units: null,
    photoProofs: [],
    status: "pending",
  });
  void db.syncQueue.put(queueItem(overrides));
}

beforeEach(() => {
  for (const store of Object.values(db)) store.rows.clear();
  apiFetch.mockReset();
});

describe("processSyncQueue", () => {
  it("uploads the day the mark was taken, not the day it syncs", async () => {
    queueAttendance();
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));

    const result = await processSyncQueue("7");

    expect(result).toMatchObject({ processed: 1, succeeded: 1, authExpired: false });
    const body = apiFetch.mock.calls[0][1].body as FormData;
    expect(body.get("attendanceDate")).toBe("2026-09-28");
    expect(db.syncQueue.rows.size).toBe(0);
  });

  it("leaves terminally failed items parked instead of retrying them every cycle", async () => {
    queueAttendance({ status: "failed", nextAttemptAt: -1, attempts: 3, lastError: "FATAL: refused" });

    const result = await processSyncQueue("7");

    expect(result.processed).toBe(0);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps items retryable after the session expires and reports it", async () => {
    queueAttendance({ attempts: 2 });
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 401 }));

    const result = await processSyncQueue("7");

    expect(result.authExpired).toBe(true);
    const item = db.syncQueue.rows.get("q-1")!;
    expect(item.attempts).toBe(2);
    expect(item.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it("parks an item the server refuses", async () => {
    queueAttendance();
    apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "This campaign assignment is closed" }), { status: 422 })
    );

    await processSyncQueue("7");

    const item = db.syncQueue.rows.get("q-1")!;
    expect(item.nextAttemptAt).toBe(-1);
    expect(item.lastError).toMatch(/^FATAL: This campaign assignment is closed/);
  });

  it("only uploads the signed-in user's items", async () => {
    queueAttendance({ userId: "8" });

    const result = await processSyncQueue("7");

    expect(result.processed).toBe(0);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
