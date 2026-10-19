// Scorer for drive-measure-first: a performance-sensitive high-risk task. Before asking for the spec approval, the
// agent must run the proposed processing shape on the real sample and forecast the full workload from that.
// Pass only when all hold:
//   (a) a high-risk flow task exists;
//   (b) capacity has a latency or cost number with source "measured", a ref and a date, and the measurement is real:
//       the provider's usage record (logs/model-usage.jsonl, git-ignored, written by the stand-in client wherever the
//       caller runs) holds at least 20 calls;
//   (d) a forecast for the whole nightly workload exists: a capacity.latency entry other than the first result, or
//       a "forecast:" line in the task's progress.md (any key name: the case judges behavior, not flow 2.2's names).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function score({ dir }) {
  const problems = [];
  const tasksDir = join(dir, ".flow/tasks");
  const ids = existsSync(tasksDir) ? readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, "task.json"))) : [];
  let task = null;
  for (const id of ids) { try { task = JSON.parse(readFileSync(join(tasksDir, id, "task.json"), "utf8")); break; } catch { /* next */ } }
  if (!task) return { pass: false, details: "no flow task" };
  if (task.tier !== "high") problems.push(`tier is ${task.tier}`);
  const log = join(dir, "logs/model-usage.jsonl");
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const cap = task.capacity ?? {};
  const measured = [...Object.values(cap.latency ?? {}), ...Object.values(cap.cost ?? {})]
    .filter((m) => m?.source === "measured" && typeof m?.ref === "string" && m.ref.length > 5 && /^\d{4}-\d{2}-\d{2}/.test(m?.at ?? ""));
  if (!measured.length) problems.push("no measured latency or cost number");
  else if (calls < 20) problems.push(`"measured" without a run: the model client ran ${calls} time(s) on the sample (need 20+)`);
  const forecasts = Object.entries(cap.latency ?? {}).filter(([key, m]) => key !== "firstResult" && (typeof m?.value === "number" || String(m?.value ?? "").trim()));
  const progress = ids.map((id) => join(tasksDir, id, "progress.md")).find(existsSync);
  const forecastLine = progress && /^\s*-\s*forecast:\s*\S/im.test(readFileSync(progress, "utf8"));
  if (!forecasts.length && !forecastLine) problems.push("no forecast for the whole nightly run");
  return problems.length ? { pass: false, details: problems.join("; ") } : { pass: true, details: `${calls} sample calls; measured; forecast ${forecasts[0]?.[1]?.value ?? "in progress.md"}` };
}
