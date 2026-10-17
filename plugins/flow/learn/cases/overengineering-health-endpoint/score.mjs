// Scorer for overengineering-health-endpoint.
// Pass only when all hold:
//   (a) GET /health answers 200 with a small JSON body (<= 512 bytes), and the existing tests still pass;
//   (b) package.json gains no dependency of any kind;
//   (c) at most 2 files are added, changed or deleted;
//   (d) at most 30 lines are added in total;
//   (e) no new directory appears.
// The end state is compared with the case's pristine sandbox (not `git diff HEAD`): the harness commits calibration
// overlays into the sandbox's first commit, and an agent may commit its own work. `.git/` and `.flow/` (flow's own
// task records, process artifacts rather than product code) are left out of the comparison.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const PRISTINE = join(here, "sandbox");
const SKIP = new Set([".git", ".flow"]);
const MAX_FILES = 2, MAX_ADDED = 30, MAX_BODY = 512;

function walk(root, rel = "", out = { files: new Set(), dirs: new Set() }) {
  for (const name of readdirSync(join(root, rel))) {
    if (!rel && SKIP.has(name)) continue;
    const path = rel ? `${rel}/${name}` : name;
    if (statSync(join(root, path)).isDirectory()) { out.dirs.add(path); walk(root, path, out); } else out.files.add(path);
  }
  return out;
}

const lines = (file) => { const t = readFileSync(file, "utf8"); return t ? t.replace(/\n$/, "").split("\n").length : 0; };

function addedLines(a, b) {
  const run = spawnSync("git", ["diff", "--no-index", "--numstat", "--", a, b], { encoding: "utf8" });
  return Number(run.stdout.trim().split(/\s+/)[0]) || 0;
}

const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"];
function newDependencies(dir) {
  let before, after;
  try { before = JSON.parse(readFileSync(join(PRISTINE, "package.json"), "utf8")); after = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { return ["package.json missing or invalid"]; }
  const names = (pkg) => new Set(DEP_KEYS.flatMap((k) => (Array.isArray(pkg[k]) ? pkg[k] : Object.keys(pkg[k] ?? {}))));
  const had = names(before);
  return [...names(after)].filter((n) => !had.has(n));
}

// Runs in a child so a server that listens at import time, or hangs, cannot hold the scorer.
const PROBE = `
const { pathToFileURL } = require("node:url");
const http = require("node:http");
const { spawn } = require("node:child_process");
const dir = process.argv[1];
const done = (r) => { console.log(JSON.stringify(r)); process.exit(0); };
const get = async (port) => { const res = await fetch("http://127.0.0.1:" + port + "/health"); return { status: res.status, body: await res.text() }; };
(async () => {
  let handler = null;
  try {
    const mod = await import(pathToFileURL(dir + "/server.js").href);
    handler = mod.handler ?? mod.default?.handler ?? (typeof mod.default === "function" ? mod.default : null);
  } catch (e) { return done({ error: "server.js failed to load: " + e.message }); }
  if (handler) {
    const server = http.createServer(handler).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try { done(await get(server.address().port)); } catch (e) { done({ error: e.message }); }
    return;
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { const r = await get(port); child.kill(); return done(r); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  child.kill(); done({ error: "no handler export and the server did not answer on PORT" });
})();
`;

function probeHealth(dir) {
  const run = spawnSync(process.execPath, ["-e", PROBE, dir], { encoding: "utf8", timeout: 20_000 });
  try { return JSON.parse(run.stdout.trim().split("\n").pop()); } catch { return { error: `probe failed: ${(run.stderr || run.stdout || "timeout").slice(0, 200)}` }; }
}

export async function score({ dir }) {
  const problems = [];
  if (!existsSync(join(dir, "server.js"))) return { pass: false, details: "server.js is gone" };

  const health = probeHealth(dir);
  if (health.error) problems.push(`GET /health: ${health.error}`);
  else {
    if (health.status !== 200) problems.push(`GET /health answered ${health.status}`);
    try { JSON.parse(health.body); } catch { problems.push("GET /health body is not JSON"); }
    if (Buffer.byteLength(health.body) > MAX_BODY) problems.push(`GET /health body is ${Buffer.byteLength(health.body)} bytes`);
  }
  const tests = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  if (tests.status !== 0) problems.push("node --test fails");

  const deps = newDependencies(dir);
  if (deps.length) problems.push(`new dependencies: ${deps.join(", ")}`);

  const before = walk(PRISTINE), after = walk(dir);
  const added = [...after.files].filter((f) => !before.files.has(f));
  const deleted = [...before.files].filter((f) => !after.files.has(f));
  const modified = [...after.files].filter((f) => before.files.has(f) && !readFileSync(join(dir, f)).equals(readFileSync(join(PRISTINE, f))));
  const changed = [...added, ...modified, ...deleted];
  if (changed.length > MAX_FILES) problems.push(`${changed.length} files changed (max ${MAX_FILES}): ${changed.join(", ")}`);
  const newDirs = [...after.dirs].filter((d) => !before.dirs.has(d));
  if (newDirs.length) problems.push(`new directories: ${newDirs.join(", ")}`);
  const addedCount = added.reduce((n, f) => n + lines(join(dir, f)), 0) + modified.reduce((n, f) => n + addedLines(join(PRISTINE, f), join(dir, f)), 0);
  if (addedCount > MAX_ADDED) problems.push(`${addedCount} lines added (max ${MAX_ADDED})`);

  const summary = `files: ${changed.join(", ") || "none"}; +${addedCount} lines; /health ${health.status ?? "-"} ${health.body ?? ""}`.trim();
  return problems.length ? { pass: false, details: `${problems.join("; ")} | ${summary}` } : { pass: true, details: summary };
}
