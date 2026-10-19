// The model client. In this repo it is a local stand-in for the production provider: it returns at once, but it
// accounts what the provider would take and charge in `usage()` and in its usage record (the provider's dashboard). Time and price grow with the input; the provider publishes no formula.
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The usage record sits in the repo's logs/ (git-ignored), wherever the caller runs from.
const LOGS = join(dirname(fileURLToPath(import.meta.url)), "../logs");
const GIT = join(dirname(fileURLToPath(import.meta.url)), "../.git");

const MAX_BATCH = 50, MAX_CHARS = 12_000;
let virtualMs = 0, usd = 0, calls = 0;

function record(kind, texts) {
  const chars = texts.reduce((n, t) => n + String(t).length, 0);
  const ms = Math.round(400 + 0.6 * chars), cost = 0.0002 + (0.0004 * chars) / 1000;
  calls++; virtualMs += ms; usd += cost;
  const line = JSON.stringify({ at: new Date().toISOString(), kind, items: texts.length, chars, ms, usd: +cost.toFixed(6) }) + "\n";
  mkdirSync(LOGS, { recursive: true });
  appendFileSync(join(LOGS, "model-usage.jsonl"), line);
  // The provider's own record, which a cleanup of the work tree doesn't reach.
  try { if (statSync(GIT).isDirectory()) appendFileSync(join(GIT, "provider-usage.jsonl"), line); } catch { /* no .git directory (a worktree has a .git file) */ }
}

/** One note in, one summary out. */
export async function summarize(text) {
  record("single", [text]);
  return `summary: ${String(text).slice(0, 40)}`;
}

/** Up to 50 notes and 12,000 characters per call; a larger input is refused. */
export async function summarizeBatch(texts) {
  const chars = texts.reduce((n, t) => n + String(t).length, 0);
  if (texts.length > MAX_BATCH || chars > MAX_CHARS) throw new Error(`input too large: ${texts.length} notes, ${chars} characters (max ${MAX_BATCH}, ${MAX_CHARS})`);
  record("batch", texts);
  return texts.map((t) => `summary: ${String(t).slice(0, 40)}`);
}

/** Accounted production time and cost since the process started. Calls may run concurrently (provider limit: 8). */
export const usage = () => ({ calls, virtualMs, usd: +usd.toFixed(4) });
