// Scorer for drive-medium-forecast: one /flow:start prompt on a medium task should carry the work to verified, in
// the same session, without handing the next flow step back to the engineer.
// Pass only when all hold:
//   (a) getForecast(city) returns { city, tempC } from the provider and a second call for the same city within
//       10 minutes does not call the provider again;
//   (b) node --test passes and some test file other than the original one exercises the forecast;
//   (c) a flow task exists with criteria, evidence for at least one of them, and a verify.md that ends with a verdict;
//   (d) the final message does not hand back a step the agent could run itself (/flow:build, verify, challenge).
//       Shipping needs a remote and GitHub, which the sandbox lacks, so naming that blocker is fine.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Runs in a child so a module that hangs or listens at import time cannot hold the scorer.
const PROBE = `
const { pathToFileURL } = require("node:url");
const dir = process.argv[1];
let calls = 0;
globalThis.fetch = async (url) => { calls++; const city = new URL(String(url)).searchParams.get("city") ?? "?"; return { ok: true, status: 200, json: async () => ({ city, temp_c: 21.4 }), text: async () => JSON.stringify({ city, temp_c: 21.4 }) }; };
(async () => {
  try {
    const mod = await import(pathToFileURL(dir + "/src/forecast.js").href);
    const get = mod.getForecast ?? mod.default?.getForecast ?? mod.default;
    if (typeof get !== "function") return console.log(JSON.stringify({ error: "no getForecast export" }));
    const a = await get("Lisbon");
    const b = await get("Lisbon");
    console.log(JSON.stringify({ a, b, calls }));
  } catch (e) { console.log(JSON.stringify({ error: e.message })); }
  process.exit(0);
})();
`;

const HANDOFF = /\b(run|use|invoke|type|call|next[^.\n]{0,10}is)\b[^.\n]{0,40}\/flow:(build|verify|challenge)\b/i;

export async function score({ dir, result }) {
  const problems = [];
  if (!existsSync(join(dir, "src/forecast.js"))) problems.push("src/forecast.js missing");
  else {
    const run = spawnSync(process.execPath, ["-e", PROBE, dir], { encoding: "utf8", timeout: 20_000 });
    let r;
    try { r = JSON.parse(run.stdout.trim().split("\n").pop()); } catch { r = { error: `probe failed: ${(run.stderr || "timeout").slice(0, 160)}` }; }
    if (r.error) problems.push(`getForecast: ${r.error}`);
    else {
      if (r.a?.city !== "Lisbon" || r.a?.tempC !== 21.4) problems.push(`getForecast returned ${JSON.stringify(r.a)}`);
      if (r.calls !== 1) problems.push(`two calls for one city reached the provider ${r.calls} times`);
    }
  }
  const tests = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  if (tests.status !== 0) problems.push("node --test fails");
  const testFiles = existsSync(join(dir, "test")) ? readdirSync(join(dir, "test")).filter((f) => f !== "format.test.js") : [];
  if (!testFiles.some((f) => /forecast/i.test(readFileSync(join(dir, "test", f), "utf8")))) problems.push("no test exercises the forecast");

  const tasksDir = join(dir, ".flow/tasks");
  const ids = existsSync(tasksDir) ? readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, "task.json"))) : [];
  if (!ids.length) problems.push("no flow task");
  else {
    const id = ids[0];
    let task = {};
    try { task = JSON.parse(readFileSync(join(tasksDir, id, "task.json"), "utf8")); } catch { problems.push("task.json is not JSON"); }
    if (!(task.criteria ?? []).length) problems.push("task has no criteria");
    if (!Object.values(task.evidence ?? {}).some((refs) => Array.isArray(refs) && refs.length)) problems.push("no criterion has evidence");
    const verify = join(tasksDir, id, "verify.md");
    if (!existsSync(verify) || !/verdict:\s*(pass|blocked)/i.test(readFileSync(verify, "utf8"))) problems.push("no verify.md with a verdict");
  }
  const text = String(result?.result ?? "");
  if (HANDOFF.test(text)) problems.push(`hands the next step back: "${HANDOFF.exec(text)[0]}"`);
  return problems.length ? { pass: false, details: problems.join("; ") } : { pass: true, details: `task ${ids[0]}; tests pass; cached` };
}
