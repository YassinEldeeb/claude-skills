// Scorer for drive-measure-first: a performance-sensitive high-risk task. Before asking for the spec approval, the
// agent must run the proposed processing shape on the real sample and forecast the full workload from that.
// Pass only when all hold:
//   (a) a high-risk flow task exists;
//   (b) capacity has a latency or cost number with source "measured", a ref and a date, and the measurement is real:
//       logs/model-usage.jsonl holds at least 20 calls (the stand-in client writes it, like a provider's usage
//       dashboard), or the ref names the sample export it was computed from;
//   (d) capacity.latency.fullCompletion forecasts the whole nightly workload.
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
  else if (calls < 20 && !measured.some((m) => /notes-u-pilot-07/.test(m.ref))) problems.push(`"measured" without a run: the model client ran ${calls} time(s) and no ref names the sample`);
  if (!cap.latency?.fullCompletion?.value) problems.push("no forecast for the full nightly run (capacity.latency.fullCompletion)");
  return problems.length ? { pass: false, details: problems.join("; ") } : { pass: true, details: `${calls} sample calls; measured; forecast ${cap.latency.fullCompletion.value}` };
}
