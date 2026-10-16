// flow learn, Prove: does a candidate change make the failure less likely, through the real mechanism?
// Deterministic tier: the real hook scripts of the baseline and candidate trees, on fixtures (free).
// Behavioral tier: `claude -p --plugin-dir <tree>/plugins/flow` in a sandbox, N runs per arm per phrasing. It costs
// model tokens, so it never runs without --approve-spend and a budget; nothing automatic ever calls it.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const learnDir = dirname(new URL(import.meta.url).pathname);
export const CASES_DIR = join(learnDir, "cases");

// ---------- statistics ----------

const Z90 = 1.6449;
/** Wilson score interval for k successes in n runs. */
export function wilson(k, n, z = Z90) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d, half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
/** Newcombe's hybrid interval for the difference p2 - p1 of two independent proportions (candidate minus baseline). */
export function diffInterval(k1, n1, k2, n2, z = Z90) {
  const p1 = n1 ? k1 / n1 : 0, p2 = n2 ? k2 / n2 : 0;
  const [l1, u1] = wilson(k1, n1, z), [l2, u2] = wilson(k2, n2, z);
  const d = p2 - p1;
  return [d - Math.sqrt((p2 - l2) ** 2 + (u1 - p1) ** 2), d + Math.sqrt((u2 - p2) ** 2 + (p1 - l1) ** 2)];
}

// ---------- cases ----------

export function loadCase(idOrDir) {
  const dir = existsSync(join(idOrDir, "case.json")) ? idOrDir : join(CASES_DIR, idOrDir);
  const spec = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
  return { ...spec, dir };
}
export const listCases = () => (existsSync(CASES_DIR) ? readdirSync(CASES_DIR).filter((d) => existsSync(join(CASES_DIR, d, "case.json"))).map(loadCase) : []);

// ---------- deterministic tier ----------

const hookPath = (tree, hook) => join(tree, "plugins/flow/hooks", `${hook}.mjs`);

/** Run one fixture against one tree's real hooks in a throwaway store. Returns { ok, got }. */
export function runFixture(tree, fixture, { hook = "guard-bash" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "flow-prove-"));
  const cwd = mkdtempSync(join(tmpdir(), "flow-prove-cwd-"));
  try {
    const env = { ...process.env, FLOW_FEEDBACK_HOME: home, CLAUDE_CODE_SESSION_ATTENDED: "1" };
    delete env.FLOW_FEEDBACK; delete env.FLOW_CONSTRAINT_RULES;
    const session = "prove";
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", `${session}.json`), JSON.stringify({ constraints: fixture.constraints ?? [] }));
    for (const prompt of fixture.prompts ?? []) {
      spawnSync(process.execPath, [hookPath(tree, "prompt")], { input: JSON.stringify({ session_id: session, cwd, prompt, source: "user", hook_event_name: "UserPromptSubmit" }), env, encoding: "utf8", timeout: 20_000 });
    }
    if (fixture.expectActive) {
      const active = JSON.parse(readFileSync(join(home, "sessions", `${session}.json`), "utf8")).constraints ?? [];
      const ok = JSON.stringify([...active].sort()) === JSON.stringify([...fixture.expectActive].sort());
      return { ok, got: `active: [${active.join(", ")}]` };
    }
    const run = spawnSync(process.execPath, [hookPath(tree, fixture.hook ?? hook)], { input: JSON.stringify({ session_id: session, cwd, tool_name: "Bash", tool_input: { command: fixture.command }, hook_event_name: "PreToolUse" }), env, encoding: "utf8", timeout: 20_000 });
    const got = run.status === 2 ? "block" : "allow";
    return { ok: got === fixture.expect, got };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

export function runDeterministic(testCase, { baseline, candidate }) {
  const arms = {};
  for (const [arm, tree] of Object.entries({ baseline, candidate })) {
    arms[arm] = testCase.fixtures.map((fixture) => ({ name: fixture.name ?? fixture.command ?? fixture.prompts?.join(" / "), heldOut: !!fixture.heldOut, ...runFixture(tree, fixture, testCase) }));
  }
  return { case: testCase.id, tier: "deterministic", arms };
}

// ---------- behavioral tier ----------

// Per-run cost estimates (USD). Measured: one 4-turn haiku task cost $0.008 on 2026-10-16; agentic cases run longer,
// and other models are scaled by list price. These are estimates for the budget check, replaced by measured cost.
export const PRICE_PER_RUN = { haiku: 0.03, sonnet: 0.12, opus: 0.6 };
const priceFor = (model) => PRICE_PER_RUN[Object.keys(PRICE_PER_RUN).find((m) => String(model).includes(m))] ?? PRICE_PER_RUN.opus;

export function estimate(testCases, { runs, model }) {
  const behavioral = testCases.filter((c) => c.kind === "behavioral");
  const total = behavioral.reduce((sum, c) => sum + c.prompts.length * 2 * runs, 0);
  return { runs: total, usd: +(total * priceFor(model)).toFixed(2), perRun: priceFor(model), model, basis: "estimate (measured haiku probe scaled by turns and list price)" };
}

export function claudeBin() {
  if (process.env.FLOW_CLAUDE_BIN) return process.env.FLOW_CLAUDE_BIN;
  const ext = join(homedir(), ".vscode/extensions");
  const found = existsSync(ext) ? readdirSync(ext).filter((d) => d.startsWith("anthropic.claude-code-")).sort().reverse().map((d) => join(ext, d, "resources/native-binary/claude")).find(existsSync) : null;
  return found ?? "claude";
}

function sandboxFor(testCase, overlay) {
  const dir = mkdtempSync(join(tmpdir(), "flow-sandbox-"));
  cpSync(join(testCase.dir, testCase.sandbox ?? "sandbox"), dir, { recursive: true });
  if (overlay) cpSync(overlay, dir, { recursive: true, force: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "commit", "-qm", "sandbox"], { cwd: dir });
  return dir;
}

async function scorer(testCase) {
  return (await import(join(testCase.dir, testCase.scorer ?? "score.mjs"))).score;
}

/** The scorer must pass the known-good end state and fail the known-bad one, or no behavioral result counts. */
export async function calibrate(testCase) {
  const score = await scorer(testCase);
  const results = {};
  for (const kind of ["good", "bad"]) {
    const dir = sandboxFor(testCase, join(testCase.dir, testCase.calibration[kind]));
    try { results[kind] = await score({ dir, result: { result: "" }, ghCalls: [] }); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return { ok: results.good.pass === true && results.bad.pass === false, good: results.good, bad: results.bad };
}

/** One headless run: real plugin loading from `tree`, a scoped sandbox, a gh stub, capture off. */
export function runOnce(testCase, prompt, tree, { model, maxTurns = 25 }) {
  const dir = sandboxFor(testCase);
  const stub = mkdtempSync(join(tmpdir(), "flow-ghstub-"));
  const ghLog = join(stub, "gh.log");
  writeFileSync(join(stub, "gh"), `#!/bin/sh\necho "$@" >> "${ghLog}"\necho "stub: gh is not available in this sandbox"\n`);
  chmodSync(join(stub, "gh"), 0o755);
  const settings = join(stub, "settings.json");
  writeFileSync(settings, JSON.stringify({ sandbox: { enabled: true, network: { allowedDomains: [] } } }));
  const args = [
    "-p", "--model", model, "--plugin-dir", join(tree, "plugins/flow"), "--setting-sources", "local", "--strict-mcp-config",
    "--settings", settings, "--permission-mode", "dontAsk", "--max-turns", String(maxTurns), "--output-format", "json",
    "--allowedTools", "Read", "Glob", "Grep", "Skill", "Bash", `Write(//${dir.replace(/^\//, "")}/**)`, `Edit(//${dir.replace(/^\//, "")}/**)`,
    "--disallowedTools", "Task", "Agent", "WebFetch", "WebSearch",
  ];
  const started = Date.now();
  const run = spawnSync(claudeBin(), args, {
    cwd: dir, input: prompt.text, encoding: "utf8", timeout: 15 * 60_000,
    env: { ...process.env, FLOW_FEEDBACK: "off", PATH: `${stub}:${process.env.PATH}` },
  });
  let result = {};
  try { result = JSON.parse(run.stdout); } catch { result = { is_error: true, result: (run.stderr || run.stdout || "").slice(0, 500) }; }
  const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, "utf8").split("\n").filter(Boolean) : [];
  return { dir, stub, result, ghCalls, ms: Date.now() - started };
}

export async function runBehavioral(testCase, { baseline, candidate, runs, model, budget, spent = { usd: 0 } }) {
  const score = await scorer(testCase);
  const arms = {};
  for (const [arm, tree] of Object.entries({ baseline, candidate })) {
    arms[arm] = [];
    for (const prompt of testCase.prompts) {
      for (let i = 0; i < runs; i++) {
        if (spent.usd >= budget) { arms[arm].push({ prompt: prompt.id, heldOut: !!prompt.heldOut, skipped: "budget reached" }); continue; }
        const run = runOnce(testCase, prompt, tree, { model, maxTurns: testCase.maxTurns });
        try {
          const verdict = await score({ dir: run.dir, result: run.result, ghCalls: run.ghCalls });
          const usd = Number(run.result.total_cost_usd ?? 0);
          spent.usd += usd;
          arms[arm].push({ prompt: prompt.id, heldOut: !!prompt.heldOut, pass: verdict.pass, details: verdict.details, usd, ms: run.ms, turns: run.result.num_turns ?? null, tokens: (run.result.usage?.output_tokens ?? 0) + (run.result.usage?.input_tokens ?? 0) + (run.result.usage?.cache_read_input_tokens ?? 0) + (run.result.usage?.cache_creation_input_tokens ?? 0), error: run.result.is_error ? String(run.result.result ?? "").slice(0, 200) : null });
        } finally { rmSync(run.dir, { recursive: true, force: true }); rmSync(run.stub, { recursive: true, force: true }); }
      }
    }
  }
  return { case: testCase.id, tier: "behavioral", mode: "plugin-dir", model, runsPerPrompt: runs, arms };
}

// ---------- skill size (paid in every session) ----------

export function sizeGrowth(baseline, candidate, files) {
  return files.map((file) => {
    const size = (tree) => (existsSync(join(tree, file)) ? statSync(join(tree, file)).size : 0);
    const before = size(baseline), after = size(candidate);
    return { file, before, after, ok: after <= before + Math.max(400, before * 0.1) };
  });
}

// ---------- the effectiveness gate ----------

const rate = (rows) => { const done = rows.filter((r) => typeof r.pass === "boolean"); return { k: done.filter((r) => r.pass).length, n: done.length }; };
const mean = (rows, key) => { const xs = rows.map((r) => r[key]).filter((x) => typeof x === "number"); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };

/**
 * Decide from results. target: the case built for this incident; suite: every other case (non-regression).
 * Never "improved" from a candidate's own test alone: the baseline must reproduce the failure, the held-out phrasing
 * must improve beyond noise, nothing else may regress, and the change must stay small and load the real way.
 */
export function judge({ target, suite = [], calibration = null, growth = [] }) {
  const reasons = [];
  if (target.tier === "deterministic") {
    const failsBaseline = target.arms.baseline.some((r) => !r.ok);
    const allCandidate = target.arms.candidate.every((r) => r.ok);
    const heldOut = target.arms.candidate.filter((r) => r.heldOut);
    if (!allCandidate) reasons.push(`candidate fails ${target.arms.candidate.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
    if (heldOut.length === 0) reasons.push("no held-out fixture (bypass attempts written apart from the fix)");
    const regressions = suite.flatMap((s) => s.arms.candidate.filter((r, i) => !r.ok && s.arms.baseline[i]?.ok).map((r) => `${s.case}: ${r.name}`));
    if (regressions.length) reasons.push(`regresses ${regressions.join(", ")}`);
    if (growth.some((g) => !g.ok)) reasons.push("skill text grows past the size budget");
    if (!failsBaseline && allCandidate) return { verdict: "already-enforced", reasons: ["the baseline already passes every fixture: nothing to fix"] };
    return { verdict: reasons.length ? "rejected" : "enforced", tier: "deterministic", reasons, evidence: "real hook scripts, baseline vs candidate" };
  }
  if (target.mode !== "plugin-dir") return { verdict: "invalid", reasons: ["results did not load the plugin the real way (plugin-dir)"] };
  if (!calibration?.ok) return { verdict: "invalid-scorer", reasons: ["the scorer does not separate its known-good and known-bad end states"] };
  const b = target.arms.baseline, c = target.arms.candidate;
  const base = rate(b);
  if (base.n === 0) return { verdict: "not-run", reasons: ["no completed baseline runs"] };
  if (base.n - base.k < base.n * 0.5) return { verdict: "cannot-reproduce", reasons: [`the baseline passed ${base.k}/${base.n}: the failure does not reproduce, so no improvement can be shown`], unverified: true };
  const hb = rate(b.filter((r) => r.heldOut)), hc = rate(c.filter((r) => r.heldOut));
  const [low, high] = diffInterval(hb.k, hb.n, hc.k, hc.n);
  const all = { baseline: base, candidate: rate(c) };
  if (!(hb.n && hc.n)) reasons.push("no held-out phrasing ran");
  else if (!(low > 0)) reasons.push(`held-out: candidate ${hc.k}/${hc.n} vs baseline ${hb.k}/${hb.n}; the 90% interval of the difference is [${low.toFixed(2)}, ${high.toFixed(2)}], which includes 0`);
  for (const s of suite) {
    const sb = rate(s.arms.baseline), sc = rate(s.arms.candidate);
    if (sb.n && sc.n && sc.k / sc.n < sb.k / sb.n - 0.15) reasons.push(`regresses ${s.case}: ${sc.k}/${sc.n} vs ${sb.k}/${sb.n}`);
  }
  const tb = mean(b, "tokens"), tc = mean(c, "tokens");
  if (tb && tc && tc > tb * 1.15) reasons.push(`tokens per run grow ${Math.round((tc / tb - 1) * 100)}% (limit 15%)`);
  if (growth.some((g) => !g.ok)) reasons.push("skill text grows past the size budget");
  const verdict = reasons.length ? (reasons.some((r) => r.startsWith("regresses")) ? "regressed" : "inconclusive") : "improved";
  return { verdict, tier: "behavioral", reasons, all, heldOut: { baseline: hb, candidate: hc, interval: [low, high] }, tokens: { baseline: tb, candidate: tc }, ms: { baseline: mean(b, "ms"), candidate: mean(c, "ms") }, usd: { baseline: mean(b, "usd"), candidate: mean(c, "usd") } };
}

/** An optional subjective grader counts only after it passes its calibration set (known-good and known-bad outputs). */
export async function graderCalibrated(grade, calibration) {
  let correct = 0;
  for (const example of calibration) if ((await grade(example.output)) === example.expected) correct++;
  return { ok: correct === calibration.length, correct, total: calibration.length };
}

// ---------- trees ----------

/** A detached worktree of `ref` from the repo holding `candidate`, for the baseline arm. */
export function baselineTree(candidate, ref) {
  const dir = mkdtempSync(join(tmpdir(), "flow-baseline-"));
  execFileSync("git", ["-C", candidate, "worktree", "add", "-q", "--detach", dir, ref], { stdio: "ignore" });
  return { dir, remove: () => { try { execFileSync("git", ["-C", candidate, "worktree", "remove", "--force", dir], { stdio: "ignore" }); } catch { rmSync(dir, { recursive: true, force: true }); } } };
}

export const changedFiles = (candidate, ref) => execFileSync("git", ["-C", candidate, "diff", "--name-only", ref], { encoding: "utf8" }).split("\n").filter(Boolean)
  .concat(execFileSync("git", ["-C", candidate, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean));

export const relativeTo = (root, path) => relative(root, path);
