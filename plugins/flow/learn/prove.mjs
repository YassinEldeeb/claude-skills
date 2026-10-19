// flow learn, Prove: does a candidate change make the failure less likely, through the real mechanism?
// Deterministic tier: the real hook scripts of the baseline and candidate trees, on fixtures (free).
// Behavioral tier: `claude -p --plugin-dir <tree>/plugins/flow` in a sandbox, N runs per arm per phrasing. It costs
// model tokens, so it never runs without --approve-spend and a budget; nothing automatic ever calls it.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { validateRules } from "./classify.mjs";

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
export const listCases = (dir = CASES_DIR) => (existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "case.json"))).map((d) => loadCase(join(dir, d))) : []);

// ---------- deterministic tier ----------

const HOOKS = ["guard-bash", "guard-edit", "prompt"];
const hookPath = (tree, hook) => {
  if (!HOOKS.includes(hook)) throw new Error(`a case may only exercise ${HOOKS.join(", ")} (got ${JSON.stringify(hook)})`);
  return join(tree, "plugins/flow/hooks", `${hook}.mjs`);
};
export const rulesOf = (tree) => { try { return JSON.parse(readFileSync(join(tree, "plugins/flow/hooks/constraint-rules.json"), "utf8")).rules ?? []; } catch { return null; } };

/**
 * Run one fixture in a throwaway store. The hook code always comes from `codeTree` (trusted: the baseline), and only
 * the constraint rules (data, the one thing an improvement may change here) come from `rulesTree`. Returns { ok, got }.
 */
export function runFixture(codeTree, fixture, { hook = "guard-bash", rulesTree = codeTree } = {}) {
  const home = mkdtempSync(join(tmpdir(), "flow-prove-"));
  const cwd = mkdtempSync(join(tmpdir(), "flow-prove-cwd-"));
  try {
    const env = { ...process.env, FLOW_FEEDBACK_HOME: home, CLAUDE_CODE_SESSION_ATTENDED: "1", FLOW_CONSTRAINT_RULES: join(rulesTree, "plugins/flow/hooks/constraint-rules.json") };
    delete env.FLOW_FEEDBACK;
    const session = "prove";
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", `${session}.json`), JSON.stringify({ constraints: fixture.constraints ?? [] }));
    for (const prompt of fixture.prompts ?? []) {
      spawnSync(process.execPath, [hookPath(codeTree, "prompt")], { input: JSON.stringify({ session_id: session, cwd, prompt, source: "user", hook_event_name: "UserPromptSubmit" }), env, encoding: "utf8", timeout: 20_000 });
    }
    if (fixture.expectActive) {
      const active = JSON.parse(readFileSync(join(home, "sessions", `${session}.json`), "utf8")).constraints ?? [];
      const ok = JSON.stringify([...active].sort()) === JSON.stringify([...fixture.expectActive].sort());
      return { ok, got: `active: [${active.join(", ")}]` };
    }
    const run = spawnSync(process.execPath, [hookPath(codeTree, fixture.hook ?? hook)], { input: JSON.stringify({ session_id: session, cwd, tool_name: "Bash", tool_input: { command: fixture.command }, hook_event_name: "PreToolUse" }), env, encoding: "utf8", timeout: 20_000 });
    const got = run.status === 2 ? "block" : "allow";
    return { ok: got === fixture.expect, got };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

export function runDeterministic(testCase, { baseline, candidate }) {
  const arms = {}, ruleErrors = {};
  for (const [arm, tree] of Object.entries({ baseline, candidate })) {
    const rules = rulesOf(tree);
    ruleErrors[arm] = rules === null ? ["constraint-rules.json is missing or not JSON"] : validateRules(rules);
    arms[arm] = testCase.fixtures.map((fixture) => {
      const name = fixture.name ?? fixture.command ?? fixture.prompts?.join(" / ");
      // Invalid or over-broad rules fail every fixture of that arm: they would disable or jam the guard in real use.
      if (ruleErrors[arm].length) return { name, heldOut: !!fixture.heldOut, ok: false, got: "invalid rules" };
      return { name, heldOut: !!fixture.heldOut, ...runFixture(baseline, fixture, { hook: testCase.hook, rulesTree: tree }) };
    });
  }
  return { case: testCase.id, tier: "deterministic", arms, ruleErrors };
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
  // A case that runs inside a flow repo gets the gate CLI too, as /flow:install leaves it (the sandbox has the config).
  if (testCase.installFlow) {
    mkdirSync(join(dir, ".github/flow"), { recursive: true });
    for (const file of ["lib.mjs", "flow.mjs"]) cpSync(join(learnDir, "../gate", file), join(dir, ".github/flow", file));
  }
  spawnSync("git", ["init", "-q", ...(testCase.installFlow ? ["-b", "main"] : [])], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "commit", "-qm", "sandbox"], { cwd: dir });
  return dir;
}

/** A case's scorer is code from a case directory: run it in a child process, scrubbed environment, time limit. */
/**
 * A scorer is code an agent may have written (auto-learn's case writer): on macOS it runs under sandbox-exec with no
 * network and no reads of the engineer's credentials or Claude state. Elsewhere it runs as before (a stated limit).
 */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export function confined(cmd, args) {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC) || process.env.FLOW_SCORER_SANDBOX === "off") return [cmd, args];
  const h = homedir();
  const secret = [".claude", ".ssh", ".aws", ".config/gh", ".gnupg", ".netrc", "Library/Keychains", ".docker"].map((p) => `(subpath "${join(h, p)}")`).join(" ");
  const profile = `(version 1)(allow default)(deny network*)(allow network* (remote unix-socket))(allow network* (local ip "localhost:*"))(allow network* (remote ip "localhost:*"))(deny file-read* ${secret})`;
  return [SANDBOX_EXEC, ["-p", profile, cmd, ...args]];
}
const SCRUBBED = () => ({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin:" + dirname(process.execPath), HOME: mkdtempSync(join(tmpdir(), "flow-score-home-")), LANG: "C" });
async function scorer(testCase) {
  const file = join(testCase.dir, testCase.scorer ?? "score.mjs");
  if (relative(testCase.dir, file).startsWith("..")) throw new Error("the scorer must live in its case directory");
  return async ({ dir, result, ghCalls }) => {
    const script = `const { score } = await import(${JSON.stringify(file)}); const input = JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify(await score(input)));`;
    const [cmd, args] = confined(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ dir, result: { result: result?.result ?? "" }, ghCalls })]);
    const run = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, env: SCRUBBED(), cwd: dir });
    try { return JSON.parse(run.stdout); } catch { return { pass: false, details: `scorer failed: ${(run.stderr || "no output").slice(0, 200)}`, scorerError: true }; }
  };
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
/**
 * The plugin as the agent under test sees it: everything but the cases (scorers and calibration answers) and the
 * tests. The rest of learn/ stays: the hooks import learn/classify.mjs and learn/store.mjs at load time.
 */
export function pluginCopy(tree) {
  const dir = mkdtempSync(join(tmpdir(), "flow-plugin-"));
  const src = join(tree, "plugins/flow");
  cpSync(src, dir, { recursive: true, filter: (p) => !/^(learn\/cases|test)(\/|$)/.test(relative(src, p)) });
  return dir;
}

/**
 * Every hook the copy declares must load and run: a hook that crashes on import fails open in Claude Code, so a run
 * would silently measure flow without its hooks. Returns the problems ([] when every hook ran).
 */
export function pluginSmoke(plugin) {
  const problems = [];
  let hooks = {};
  try { hooks = JSON.parse(readFileSync(join(plugin, "hooks/hooks.json"), "utf8")).hooks ?? {}; } catch (error) { return [`hooks.json: ${error.message}`]; }
  const home = mkdtempSync(join(tmpdir(), "flow-smoke-home-")), cwd = mkdtempSync(join(tmpdir(), "flow-smoke-cwd-"));
  try {
    for (const [event, groups] of Object.entries(hooks)) {
      for (const hook of groups.flatMap((g) => g.hooks ?? [])) {
        const script = /"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(hook.command ?? "")?.[1];
        if (!script) { problems.push(`${event}: can't read the script from ${JSON.stringify(hook.command)}`); continue; }
        const run = spawnSync(process.execPath, [join(plugin, script)], {
          cwd, input: JSON.stringify({ session_id: "smoke", cwd, hook_event_name: event }), encoding: "utf8", timeout: 20_000,
          env: { ...process.env, FLOW_FEEDBACK: "off", FLOW_FEEDBACK_HOME: home, CLAUDE_PLUGIN_ROOT: plugin },
        });
        if (run.status !== 0 && run.status !== 2) problems.push(`${event} ${script}: exit ${run.status} ${(run.stderr || "").split("\n").find((l) => /Error|Cannot find/.test(l)) ?? ""}`.trim());
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
  return problems;
}

export async function runOnce(testCase, prompt, tree, { model, maxTurns = 25 }) {
  const dir = sandboxFor(testCase);
  const plugin = pluginCopy(tree);
  const broken = pluginSmoke(plugin);
  if (broken.length) {
    rmSync(plugin, { recursive: true, force: true });
    return { dir, stub: mkdtempSync(join(tmpdir(), "flow-ghstub-")), result: { is_error: true, result: `the plugin copy's hooks don't run: ${broken.join("; ")}` }, ghCalls: [], ms: 0 };
  }
  const store = mkdtempSync(join(tmpdir(), "flow-eval-store-"));
  const stub = mkdtempSync(join(tmpdir(), "flow-ghstub-"));
  const ghLog = join(stub, "gh.log");
  writeFileSync(join(stub, "gh"), `#!/bin/sh\necho "$@" >> "${ghLog}"\necho "stub: gh is not available in this sandbox"\n`);
  chmodSync(join(stub, "gh"), 0o755);
  const settings = join(stub, "settings.json");
  writeFileSync(settings, JSON.stringify({ sandbox: { enabled: true, network: { allowedDomains: [] } } }));
  const args = [
    "-p", "--model", model, "--plugin-dir", plugin, "--setting-sources", "local", "--strict-mcp-config",
    "--settings", settings, "--permission-mode", "dontAsk", "--max-turns", String(maxTurns), "--output-format", "json",
    "--allowedTools", "Skill", "Bash", ...["Read", "Glob", "Grep", "Write", "Edit"].map((t) => `${t}(//${dir.replace(/^\//, "")}/**)`),
    "--disallowedTools", "Task", "Agent", "WebFetch", "WebSearch",
  ];
  const started = Date.now();
  const run = await spawnAsync(claudeBin(), args, {
    cwd: dir, input: prompt.text, timeout: 15 * 60_000,
    // Scrubbed: no parent-session variables, the engineer's feedback store or tokens leak into the run.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|FLOW_|GH_|GITHUB_)/.test(k) && !/TOKEN|SECRET|KEY/.test(k))), FLOW_FEEDBACK: "off", FLOW_FEEDBACK_HOME: store, PATH: `${stub}:${process.env.PATH}` },
  });
  rmSync(plugin, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
  let result = {};
  try { result = JSON.parse(run.stdout); } catch { result = { is_error: true, result: (run.stderr || run.stdout || "").slice(0, 500) }; }
  const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, "utf8").split("\n").filter(Boolean) : [];
  return { dir, stub, result, ghCalls, ms: Date.now() - started };
}

/**
 * Claude Code writes its own state into the working directory (`.claude/`, e.g. `.claude/.cc-writes` for sandboxed
 * writes). It is the tool's, not the agent's work: removed before scoring, or every case would see a stray directory.
 */
export function withoutToolState(dir) {
  rmSync(join(dir, ".claude"), { recursive: true, force: true });
  return dir;
}

/** spawnSync's result shape, without blocking: several runs go at once. A timeout kills the whole process group. */
function spawnAsync(cmd, args, { cwd, input, env, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", done = false;
    const finish = (status) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(grace); resolve({ status, stdout, stderr }); };
    const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
    const timer = setTimeout(() => { killGroup(); stderr += "\n[flow] timed out"; }, timeout);
    let grace = null;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => { stderr ||= error.message; finish(null); });
    // A grandchild holding the pipes open must not hang the pool: after exit, wait a moment for output, then go.
    child.on("exit", (status) => { grace = setTimeout(() => { killGroup(); finish(status); }, 5_000); });
    child.on("close", (status) => finish(status));
    child.stdin.on("error", () => { /* the child exited before reading */ });
    child.stdin.end(input ?? "");
  });
}

/** How many runs go at once (FLOW_EVAL_CONCURRENCY, default 4). */
export const evalConcurrency = () => {
  const raw = process.env.FLOW_EVAL_CONCURRENCY;
  if (raw == null || raw === "") return 4;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

export async function runBehavioral(testCase, { baseline, candidate, runs, model, budget, spent = { usd: 0 }, concurrency = evalConcurrency() }) {
  const score = await scorer(testCase);
  const arms = { baseline: [], candidate: [] };
  // Interleaved (baseline, candidate, baseline, ...) so an outage or rate limit hits both arms alike; results keep
  // that order whatever finishes first.
  const jobs = [];
  for (const prompt of testCase.prompts) for (let i = 0; i < runs; i++) for (const [arm, tree] of Object.entries({ baseline, candidate })) jobs.push({ prompt, arm, tree });
  const out = new Array(jobs.length);
  let next = 0, inFlight = 0, perRun = 0;
  const one = async (job) => {
    const { prompt, arm, tree } = job;
    const run = await runOnce(testCase, prompt, tree, { model, maxTurns: testCase.maxTurns });
    try {
      const usd = Number(run.result.total_cost_usd ?? 0);
      spent.usd += usd;
      perRun = Math.max(perRun, usd);
      const u = run.result.usage ?? {};
      const tokens = (u.output_tokens ?? 0) + (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      // A run that errored or never took a turn says nothing about behavior: excluded, not scored as a failure.
      if (run.result.is_error || !run.result.num_turns) return { prompt: prompt.id, heldOut: !!prompt.heldOut, error: String(run.result.result ?? "no result").slice(0, 200), usd, ms: run.ms };
      const verdict = await score({ dir: withoutToolState(run.dir), result: run.result, ghCalls: run.ghCalls });
      if (verdict.scorerError) return { prompt: prompt.id, heldOut: !!prompt.heldOut, error: verdict.details, usd, ms: run.ms };
      return { prompt: prompt.id, heldOut: !!prompt.heldOut, pass: verdict.pass, details: verdict.details, usd, ms: run.ms, turns: run.result.num_turns, tokens: tokens || null };
    } finally { rmSync(run.dir, { recursive: true, force: true }); rmSync(run.stub, { recursive: true, force: true }); }
  };
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      // Runs in flight count at the highest cost seen so far, so the budget holds with several runs at once.
      if (spent.usd + inFlight * perRun >= budget) { out[index] = { arm: job.arm, row: { prompt: job.prompt.id, heldOut: !!job.prompt.heldOut, skipped: "budget reached" } }; continue; }
      inFlight++;
      try { out[index] = { arm: job.arm, row: await one(job) }; } finally { inFlight--; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  for (const { arm, row } of out) arms[arm].push(row);
  return { case: testCase.id, tier: "behavioral", mode: "plugin-dir", model, runsPerPrompt: runs, concurrency, arms };
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
const suiteRegressions = (suite) => suite.flatMap((s) => {
  if (s.tier === "deterministic") return s.arms.candidate.filter((r, i) => !r.ok && s.arms.baseline[i]?.ok).map((r) => `${s.case}: ${r.name}`);
  const sb = rate(s.arms.baseline), sc = rate(s.arms.candidate);
  return sb.n && sc.n && sc.k / sc.n < sb.k / sb.n - 0.15 ? [`${s.case}: ${sc.k}/${sc.n} vs ${sb.k}/${sb.n}`] : [];
});

export function judge({ target, suite = [], expectedSuite = null, calibration = null, growth = [] }) {
  const reasons = [];
  // The no-regression check is not optional: every other case of the suite must have been run.
  if (expectedSuite) {
    const missing = expectedSuite.filter((id) => !suite.some((s) => s.case === id));
    if (missing.length) reasons.push(`the suite was not fully run (missing: ${missing.join(", ")})`);
  }
  if (target.tier === "deterministic") {
    const failsBaseline = target.arms.baseline.some((r) => !r.ok);
    const allCandidate = target.arms.candidate.every((r) => r.ok);
    const heldOut = target.arms.candidate.filter((r) => r.heldOut);
    if (target.ruleErrors?.candidate?.length) reasons.push(`the candidate's constraint rules are invalid: ${target.ruleErrors.candidate.join("; ")}`);
    else if (!allCandidate) reasons.push(`candidate fails ${target.arms.candidate.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
    if (heldOut.length < 3) reasons.push(`only ${heldOut.length} held-out fixture(s): at least 3, written apart from the fix and not seen by its author`);
    const regressions = suiteRegressions(suite);
    if (regressions.length) reasons.push(`regresses ${regressions.join(", ")}`);
    if (growth.some((g) => !g.ok)) reasons.push("skill text grows past the size budget");
    if (!failsBaseline && allCandidate) return { verdict: "already-enforced", reasons: ["the baseline already passes every fixture: nothing to fix"] };
    return { verdict: reasons.length ? "rejected" : "enforced", tier: "deterministic", reasons, evidence: "real hook scripts, baseline vs candidate" };
  }
  if (target.mode !== "plugin-dir") return { verdict: "invalid", reasons: ["results did not load the plugin the real way (plugin-dir)"] };
  if (!calibration?.ok) return { verdict: "invalid-scorer", reasons: ["the scorer does not separate its known-good and known-bad end states"] };
  const b = target.arms.baseline, c = target.arms.candidate;
  const errors = [...b, ...c].filter((r) => r.error).length, attempted = [...b, ...c].filter((r) => !r.skipped).length;
  if (attempted && errors / attempted > 0.2) return { verdict: "invalid", reasons: [`${errors}/${attempted} runs errored (outage, rate limit, sandbox): too many to judge`] };
  const base = rate(b);
  if (base.n === 0) return { verdict: "not-run", reasons: ["no completed baseline runs"] };
  if (base.n - base.k < base.n * 0.5) return { verdict: "cannot-reproduce", reasons: [`the baseline passed ${base.k}/${base.n}: the failure does not reproduce, so no improvement can be shown`], unverified: true };
  const hb = rate(b.filter((r) => r.heldOut)), hc = rate(c.filter((r) => r.heldOut));
  const [low, high] = diffInterval(hb.k, hb.n, hc.k, hc.n);
  const all = { baseline: base, candidate: rate(c) };
  if (!(hb.n && hc.n)) reasons.push("no held-out phrasing ran");
  else if (!(low > 0)) reasons.push(`held-out: candidate ${hc.k}/${hc.n} vs baseline ${hb.k}/${hb.n}; the 90% interval of the difference is [${low.toFixed(2)}, ${high.toFixed(2)}], which includes 0`);
  for (const r of suiteRegressions(suite)) reasons.push(`regresses ${r}`);
  const tb = mean(b, "tokens"), tc = mean(c, "tokens");
  if (tb && tc && tc > tb * 1.15) reasons.push(`tokens per run grow ${Math.round((tc / tb - 1) * 100)}% (limit 15%)`);
  if (growth.some((g) => !g.ok)) reasons.push("skill text grows past the size budget");
  if (tb == null || tc == null) reasons.push("token usage was not reported, so overhead can't be checked");
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

/** Hash of a checkout's content (tracked and untracked, not ignored), via a temporary index. */
export function treeHash(dir) {
  const index = join(mkdtempSync(join(tmpdir(), "flow-index-")), "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    execFileSync("git", ["-C", dir, "read-tree", "HEAD"], { env, stdio: "ignore" });
    execFileSync("git", ["-C", dir, "add", "-A"], { env, stdio: "ignore" });
    return execFileSync("git", ["-C", dir, "write-tree"], { env, encoding: "utf8" }).trim();
  } finally { rmSync(dirname(index), { recursive: true, force: true }); }
}

export const changedFiles = (candidate, ref) => execFileSync("git", ["-C", candidate, "diff", "--name-only", ref], { encoding: "utf8" }).split("\n").filter(Boolean)
  .concat(execFileSync("git", ["-C", candidate, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean));

