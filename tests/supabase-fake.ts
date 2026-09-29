type Result = { data?: unknown; error?: unknown };
export type RecordedQuery = { table: string; op: string; payload?: unknown; filters: unknown[][] };

/** Minimal chainable Supabase stand-in: results are queued per `table.op` and consumed in call order. */
export function createSupabaseFake() {
  const queues = new Map<string, Result[]>();
  const queries: RecordedQuery[] = [];

  const client = {
    from(table: string) {
      const query: RecordedQuery = { table, op: "select", filters: [] };
      queries.push(query);
      const resolve = () => {
        const queue = queues.get(`${table}.${query.op}`) || [];
        const next = queue.shift() || {};
        return Promise.resolve({ data: next.data ?? null, error: next.error ?? null });
      };
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq", "not", "in", "ilike", "order", "limit", "or"]) {
        builder[method] = (...args: unknown[]) => {
          if (method !== "select") query.filters.push([method, ...args]);
          return builder;
        };
      }
      for (const op of ["insert", "update", "upsert", "delete"]) {
        builder[op] = (payload?: unknown) => {
          query.op = op;
          query.payload = payload;
          return builder;
        };
      }
      builder.single = resolve;
      builder.maybeSingle = resolve;
      builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        resolve().then(onFulfilled, onRejected);
      return builder;
    },
  };

  return {
    client,
    queries,
    reset(next: Record<string, Result[]>) {
      queues.clear();
      queries.length = 0;
      for (const [key, results] of Object.entries(next)) queues.set(key, [...results]);
    },
    find(table: string, op: string) {
      return queries.filter((query) => query.table === table && query.op === op);
    },
  };
}
