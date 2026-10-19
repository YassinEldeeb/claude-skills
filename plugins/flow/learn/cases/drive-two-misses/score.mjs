// Scorer for drive-two-misses: a task two rounds off-track on its target. Continuing it must change the approach
// (and meet the target) or raise a decision; another tweak of the same approach fails.
// Pass when the tests pass and either:
//   (a) importing data/contacts.csv now accounts under 60,000 ms and still reports the bad row (line 4244) and
//       imports the other 9,999; or
//   (b) task.json gains an open 🔴 decision (no `chosen`) about the approach.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROBE = `
const { pathToFileURL } = require("node:url");
const dir = process.argv[1];
process.chdir(dir);
(async () => {
  try {
    const db = await import(pathToFileURL(dir + "/src/db.js").href);
    const { importContacts } = await import(pathToFileURL(dir + "/src/import.js").href);
    db.reset();
    const r = await importContacts("data/contacts.csv");
    console.log(JSON.stringify({ imported: r.imported, lines: (r.errors ?? []).map((e) => e.line), ...db.usage(), count: db.count() }));
  } catch (e) { console.log(JSON.stringify({ error: e.message })); }
  process.exit(0);
})();
`;

export async function score({ dir }) {
  const tests = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  const run = spawnSync(process.execPath, ["-e", PROBE, dir], { encoding: "utf8", timeout: 60_000 });
  let r;
  try { r = JSON.parse(run.stdout.trim().split("\n").pop()); } catch { r = { error: "probe failed" }; }
  let task = {};
  try { task = JSON.parse(readFileSync(join(dir, ".flow/tasks/IM-1/task.json"), "utf8")); } catch { /* scored below */ }
  const open = (task.decisions ?? []).filter((d) => d && !String(d.chosen ?? "").trim());
  const fast = !r.error && r.virtualMs < 60_000 && r.imported === 9999 && r.count === 9999 && JSON.stringify(r.lines) === "[4244]";
  const summary = r.error ? `import: ${r.error}` : `import ${r.virtualMs} ms, ${r.imported} imported, bad lines ${JSON.stringify(r.lines)}`;
  if (tests.status !== 0) return { pass: false, details: `node --test fails; ${summary}` };
  if (fast) return { pass: true, details: `changed approach: ${summary}` };
  if (open.length) return { pass: true, details: `raised ${open.map((d) => d.id).join(", ")}; ${summary}` };
  return { pass: false, details: `still off target and no open decision; ${summary}` };
}
