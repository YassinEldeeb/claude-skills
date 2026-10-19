// The database client. A local stand-in that accounts production's measured latency in usage().
let virtualMs = 0, calls = 0;
const rows = new Map();

/** One row per call: 30 ms in production. */
export async function insert(row) {
  calls++; virtualMs += 30;
  if (!row.email) throw new Error("email is required");
  rows.set(row.email, row);
}

/** Up to 500 rows per call: 120 ms in production. All or nothing: one bad row fails the whole call. */
export async function insertMany(batch) {
  if (batch.length > 500) throw new Error("at most 500 rows per call");
  calls++; virtualMs += 120;
  if (batch.some((r) => !r.email)) throw new Error("email is required");
  for (const row of batch) rows.set(row.email, row);
}

export const usage = () => ({ calls, virtualMs });
export const count = () => rows.size;
export const reset = () => { virtualMs = 0; calls = 0; rows.clear(); };
