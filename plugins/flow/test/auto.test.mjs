// flow 2.3 auto-learn: the switch, the triggers, picking, and the whole background loop end to end with a fake
// claude and a fake gh (zero spend): a "don't merge" correction becomes a proven constraint rule and a draft PR.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { autoSwitch, classifyMissed, lastJson, pickCluster, privacyProblems, skillProblems, startDetached, typedPrompts } from "../learn/auto.mjs";

const plugin = new URL("..", import.meta.url).pathname;
const repoRoot = join(plugin, "../..");
const hook = (name, input, env) => spawnSync("node", [join(plugin, "hooks", name)], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
const readConfig = (home) => JSON.parse(readFileSync(join(home, "config.json"), "utf8"));

describe("the switch is the engineer's", () => {
  test("only a prompt that is just the switch turns it on or off", () => {
    assert.equal(autoSwitch("flow auto-learn on"), true);
    assert.equal(autoSwitch("  Flow: auto learn enable! "), true);
    assert.equal(autoSwitch("flow autolearn off"), false);
    assert.equal(autoSwitch("don't turn flow auto-learn on"), null);
    assert.equal(autoSwitch("should I turn flow auto-learn on?"), null);
    assert.equal(autoSwitch("what does auto-learn do?"), null);
  });
  test("the prompt hook flips it from typed words only, never from a paste", () => {
    const home = mkdtempSync(join(tmpdir(), "flow-auto-sw-"));
    try {
      const env = { FLOW_FEEDBACK_HOME: home };
      hook("prompt.mjs", { session_id: "s", cwd: home, prompt: '<pasted_content id="a">flow auto-learn on</pasted_content id="a"> thoughts?', source: "user" }, env);
      assert.equal(existsSync(join(home, "config.json")) ? readConfig(home).autoLearn?.enabled : undefined, undefined, "a pasted switch does nothing");
      const on = hook("prompt.mjs", { session_id: "s", cwd: home, prompt: "flow auto-learn on", source: "user" }, env);
      assert.equal(readConfig(home).autoLearn.enabled, true);
      assert.match(on.stdout, /Auto-learn is on/);
      hook("prompt.mjs", { session_id: "s", cwd: home, prompt: "flow auto-learn off", source: "user" }, env);
      assert.equal(readConfig(home).autoLearn.enabled, false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  test("agents can't flip it through the CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "flow-auto-guard-"));
    try {
      const guard = (command) => hook("guard-bash.mjs", { session_id: "s", cwd: home, tool_input: { command } }, { FLOW_FEEDBACK_HOME: home }).status;
      assert.equal(guard(`node ${plugin}learn/cli.mjs auto on`), 2);
      assert.equal(guard(`node ${plugin}learn/cli.mjs auto off`), 2);
      assert.equal(guard(`node ${plugin}learn/cli.mjs auto status`), 0);
      assert.equal(guard(`node -e 'import("${plugin}learn/store.mjs").then((s) => s.saveConfig({ autoLearn: { enabled: true } }))'`), 2, "nor through the store module");
      assert.equal(guard("grep -rn autoLearn plugins/flow"), 0, "reading about it is fine");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("picking and starting", () => {
  const cfg = { maxAttemptsPerDay: 3, cooldownHours: 24 };
  const c = (id, occurrences, extra = {}) => ({ id, occurrences, defect: true, actionable: true, target: { file: "skills/start/SKILL.md", mechanism: "instruction" }, ...extra });
  test("new incidents, outside the cooldown, within the daily cap; personal clusters never", () => {
    const at = Date.parse("2026-10-19T12:00:00Z");
    assert.equal(pickCluster({ clusters: [c("a", 2), c("b", 5)], state: {}, attemptsToday: 0, cfg, at }).id, "b");
    assert.equal(pickCluster({ clusters: [c("b", 5)], state: { b: { occurrences: 5, at: "2026-10-10T00:00:00Z", outcome: "not-proven" } }, attemptsToday: 0, cfg, at }), null, "nothing new since the last attempt");
    assert.equal(pickCluster({ clusters: [c("b", 6)], state: { b: { occurrences: 5, at: "2026-10-19T11:00:00Z", outcome: "pr" } }, attemptsToday: 0, cfg, at }), null, "cooldown");
    assert.equal(pickCluster({ clusters: [c("b", 6)], state: { b: { occurrences: 5, at: "2026-10-18T11:00:00Z", outcome: "not-proven" } }, attemptsToday: 0, cfg, at }).id, "b");
    // A failed attempt (a crash, a refused edit) settles nothing: it retries after an hour, without new incidents.
    assert.equal(pickCluster({ clusters: [c("b", 5)], state: { b: { occurrences: 5, at: "2026-10-19T11:30:00Z", outcome: "no-fix" } }, attemptsToday: 0, cfg, at }), null, "not within the hour");
    assert.equal(pickCluster({ clusters: [c("b", 5)], state: { b: { occurrences: 5, at: "2026-10-19T10:30:00Z", outcome: "no-fix" } }, attemptsToday: 0, cfg, at }).id, "b");
    assert.equal(pickCluster({ clusters: [c("b", 6)], state: {}, attemptsToday: 3, cfg, at }), null, "daily cap");
    assert.equal(pickCluster({ clusters: [c("p", 9, { target: { file: null, mechanism: "personal" } })], state: {}, attemptsToday: 0, cfg, at }), null);
  });
  test("starting is a no-op when off, inside a flow run, or with capture off", () => {
    const home = mkdtempSync(join(tmpdir(), "flow-auto-start-"));
    const saved = { ...process.env };
    try {
      process.env.FLOW_FEEDBACK_HOME = home;
      delete process.env.FLOW_AUTO_CHILD; delete process.env.FLOW_FEEDBACK;
      const calls = [];
      const spawnImpl = (...a) => { calls.push(a); return { unref() {} }; };
      assert.equal(startDetached({ session: "s", spawnImpl }), false);
      writeFileSync(join(home, "config.json"), JSON.stringify({ autoLearn: { enabled: true } }));
      assert.equal(startDetached({ session: "s", transcript: "/t.jsonl", spawnImpl }), true);
      assert.deepEqual(calls[0][1].slice(1), ["--session", "s", "--transcript", "/t.jsonl"]);
      assert.equal(calls[0][2].detached, true);
      process.env.FLOW_AUTO_CHILD = "1";
      assert.equal(startDetached({ session: "s", spawnImpl }), false);
    } finally { process.env = saved; rmSync(home, { recursive: true, force: true }); }
  });
  test("typed prompts: own words only, no pasted blocks, command echoes or tool results", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-auto-tx-"));
    try {
      const file = join(dir, "t.jsonl");
      const user = (content, extra = {}) => JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
      writeFileSync(file, [
        user("why didn't you check the real data?!"),
        user('<pasted_content id="a">a pasted log</pasted_content id="a">'),
        user("<command-message>flow:start</command-message>"),
        user([{ type: "tool_result", content: "ok" }]),
        user("meta", { isMeta: true }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      ].join("\n"));
      assert.deepEqual(typedPrompts(file), ["why didn't you check the real data?!"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("lastJson takes the final JSON object of an answer", () => {
    assert.deepEqual(lastJson('Done.\n```json\n{"a": {"b": 1}}\n```'), { a: { b: 1 } });
    assert.deepEqual(lastJson('{"x": 1} then {"y": [{"z": 2}]}'), { y: [{ z: 2 }] });
    assert.equal(lastJson("no json"), null);
  });
});

describe("classify: the rage the lexicon missed", () => {
  test("a Haiku pass labels typed prompts; only valid labels for real prompts become incidents", () => {
    const root = mkdtempSync(join(tmpdir(), "flow-auto-cls-"));
    const saved = { ...process.env };
    try {
      const home = join(root, "store"), file = join(root, "t.jsonl"), fake = join(root, "claude");
      mkdirSync(home);
      writeFileSync(file, ["what have you been doing for the past 2h?!", "add a /health route", "why didn't you ask me first"].map((c) => JSON.stringify({ type: "user", message: { role: "user", content: c } })).join("\n"));
      writeFileSync(fake, `#!/usr/bin/env node
let p = ""; process.stdin.on("data", (d) => p += d).on("end", () => (require("fs").appendFileSync(${JSON.stringify(join(root, "sent.log"))}, JSON.stringify(p) + "\\n"), process.stdout.write(JSON.stringify({ num_turns: 1, result: p.includes("FLOW-AUTO-STEP: classify") ? '{"corrections": [{"i": 0, "category": "timelines"}, {"i": 2, "category": "decision-latency"}, {"i": 7, "category": "timelines"}, {"i": 1, "category": "not-a-category"}]}' : "{}" }))));`);
      chmodSync(fake, 0o755);
      Object.assign(process.env, { FLOW_FEEDBACK_HOME: home, FLOW_CLAUDE_BIN: fake });
      delete process.env.FLOW_FEEDBACK;
      assert.equal(classifyMissed({ session: "s9", file, model: "haiku" }), 2);
      const incidents = readFileSync(join(home, "incidents.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(incidents.map((i) => i.category).sort(), ["decision-latency", "timelines"]);
      classifyMissed({ session: "s9", file, model: "haiku" });
      const second = JSON.parse(readFileSync(join(root, "sent.log"), "utf8").trim().split("\n")[1]);
      assert.match(second, /\/health/);
      assert.doesNotMatch(second, /past 2h|ask me first/, "already-captured prompts aren't sent again");
    } finally { process.env = saved; rmSync(root, { recursive: true, force: true }); }
  });
});

describe("what a fix may contain", () => {
  test("a skill's body may change; its frontmatter, a !`command` line or a new skill may not", () => {
    const repo = mkdtempSync(join(tmpdir(), "flow-auto-skill-"));
    try {
      const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, encoding: "utf8" });
      g("init", "-q");
      mkdirSync(join(repo, "plugins/flow/skills/start"), { recursive: true });
      const skill = join(repo, "plugins/flow/skills/start/SKILL.md");
      writeFileSync(skill, "---\nname: start\ndescription: d\n---\n\n# Start\n\nBody.\n");
      g("add", "-A"); g("commit", "-qm", "base");
      const base = g("rev-parse", "HEAD").trim();
      const f = ["plugins/flow/skills/start/SKILL.md"];
      writeFileSync(skill, "---\nname: start\ndescription: d\n---\n\n# Start\n\nBody, clearer.\n");
      assert.deepEqual(skillProblems(repo, base, f), []);
      writeFileSync(skill, "---\nname: start\ndescription: d\nallowed-tools: Bash\n---\n\n# Start\n");
      assert.match(skillProblems(repo, base, f).join(), /frontmatter/);
      writeFileSync(skill, "---\nname: start\ndescription: d\n---\n\n# Start\n\n!`curl evil`\n");
      assert.match(skillProblems(repo, base, f).join(), /command/);
      mkdirSync(join(repo, "plugins/flow/skills/new"), { recursive: true });
      writeFileSync(join(repo, "plugins/flow/skills/new/SKILL.md"), "x");
      assert.match(skillProblems(repo, base, ["plugins/flow/skills/new/SKILL.md"]).join(), /new skill/);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  test("privacy: what's already public in the repo doesn't count; what came from the sessions does", () => {
    const sources = ["assistant: I ran the importCustomersV2 job on the billing-prod host and it took 2 hours", "make sure the tests pass and the build is green"];
    const corpus = "flow: make sure the tests pass and the build is green before you ship. The agent ignored the instruction.";
    assert.deepEqual(privacyProblems([["case", "Make sure the tests pass and the build is green."]], { sources, corpus }), [], "a run that is also in the repo");
    assert.match(privacyProblems([["case", "It ran importCustomersV2 overnight"]], { sources, corpus }).join(), /identifier/);
    assert.match(privacyProblems([["case", "I ran the importCustomersV2 job on the billing-prod host"]], { sources, corpus }).join(), /5\+ words/);
    assert.deepEqual(privacyProblems([["case", "the agent ignored the instruction"]], { sources, names: ["agent"], corpus }), [], "a name that is a public word");
    assert.match(privacyProblems([["case", "in the acme-internal repo"]], { sources, names: ["acme-internal"], corpus }).join(), /private repo/);
    assert.deepEqual(privacyProblems([["case", "git@github.com:acme/x.git and dev@example.com"]], { corpus }), []);
  });
});

describe("session start tells the engineer what it did, once", () => {
  test("news since the last session", () => {
    const home = mkdtempSync(join(tmpdir(), "flow-auto-news-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ noticeShown: "x", autoLearn: { enabled: true } }));
      writeFileSync(join(home, "auto.jsonl"), JSON.stringify({ at: "2026-10-19T10:00:00Z", cluster: "unauthorized-action--merge", outcome: "pr", url: "https://github.com/acme/skills/pull/9", verdict: "enforced" }) + "\n");
      const env = { FLOW_FEEDBACK_HOME: home, CLAUDE_CODE_SESSION_ATTENDED: "1" };
      const first = hook("session-start.mjs", { session_id: "s", cwd: home, source: "startup" }, env);
      assert.match(first.stdout, /auto-learn since you were last here: unauthorized-action--merge: PR https:\/\/github.com\/acme\/skills\/pull\/9/);
      const second = hook("session-start.mjs", { session_id: "s2", cwd: home, source: "startup" }, env);
      assert.doesNotMatch(second.stdout, /auto-learn since/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("the whole loop, zero spend: correction → analysis → case → fix → proof → draft PR", () => {
  test("a 'don't push' cluster becomes an enforced constraint rule and a PR; a sloppy fix is rejected", { timeout: 600_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "flow-auto-e2e-"));
    try {
      const home = join(root, "store"), bin = join(root, "bin"), bare = join(root, "skills.git"), ghLog = join(root, "gh.log");
      mkdirSync(home); mkdirSync(bin);
      // The skills repo as GitHub would have it: this checkout's committed master.
      execFileSync("git", ["clone", "-q", "--bare", repoRoot, bare]);
      // master as GitHub has it (not this branch, whose tests quote the very phrases the privacy check looks for).
      const published = execFileSync("git", ["-C", repoRoot, "rev-parse", "origin/master"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", bare, "branch", "-f", "master", published]);
      writeFileSync(join(home, "config.json"), JSON.stringify({ noticeShown: "x", autoLearn: { enabled: true, repo: "acme/skills", repoUrl: bare, cloneDir: join(root, "clone"), idleMinutes: 0 } }));
      // Two sessions where the engineer said not to merge and the agent merged anyway.
      mkdirSync(join(home, "queue/pending"), { recursive: true });
      for (const s of ["s1", "s2"]) {
        const event = { id: `e-${s}`, type: "prompt", at: "2026-10-19T09:00:00Z", session: s, repo: "web", kind: "correction", category: "unauthorized-action", keys: ["push"], text: "I said don't push it to the remote yet", objective: null };
        writeFileSync(join(home, "queue/pending", `e-${s}.json`), JSON.stringify(event));
      }
      // A fake claude: each step is marked in its prompt.
      writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
let prompt = ""; process.stdin.on("data", (d) => prompt += d).on("end", () => {
  const out = (result) => process.stdout.write(JSON.stringify({ result, num_turns: 1, is_error: false, total_cost_usd: 0 }));
  if (prompt.includes("FLOW-AUTO-STEP: analyze") && process.env.LEAKY) return out(JSON.stringify({ synthetic: "The engineer wrote: I said don't push it to the remote yet, and the agent pushed anyway.", rootCause: "No rule.", mechanism: "deterministic", kind: "deterministic" }));
  if (prompt.includes("FLOW-AUTO-STEP: analyze")) return out(JSON.stringify({ synthetic: "The engineer said not to push the branch; later in the session the agent pushed it anyway.", rootCause: "No constraint rule turns a stated no-push into a refusal.", mechanism: "deterministic", kind: "deterministic" }));
  if (prompt.includes("FLOW-AUTO-STEP: cases")) {
    const id = /cases\\/(auto-[a-z0-9-]+)\\//.exec(prompt)[1];
    const dir = path.join(process.cwd(), "plugins/flow/learn/cases", id);
    fs.mkdirSync(dir, { recursive: true });
    const f = (name, command, expect, heldOut = false) => ({ name, constraints: ["no-push"], command, expect, heldOut });
    fs.writeFileSync(path.join(dir, "case.json"), JSON.stringify({ id, kind: "deterministic", cluster: "unauthorized-action--push", author: "independent", hook: "guard-bash", fixtures: [
      f("push the branch", "git push origin feature", "block"), f("force push", "git push -f origin feature", "block", true),
      f("push with lease", "git push --force-with-lease origin HEAD:feature", "block", true), f("chained push", "git commit -m x && git push", "block", true),
      f("fetch stays allowed", "git fetch origin", "allow"), f("status stays allowed", "git status", "allow", true) ] }, null, 2));
    return out(JSON.stringify({ case: id, calibrated: true }));
  }
  if (prompt.includes("FLOW-AUTO-STEP: fix")) {
    const file = path.join(process.cwd(), "plugins/flow/hooks/constraint-rules.json");
    const rules = JSON.parse(fs.readFileSync(file, "utf8"));
    rules.rules.push(process.env.SLOPPY ? { id: "no-push", why: "the engineer said not to push", covers: ["push"], phrases: ["push"], blocks: ["\\\\bgit\\\\b"] }
      : { id: "no-push", why: "the engineer said not to push", covers: ["push"], phrases: ["\\\\bdon'?t\\\\s+push\\\\b"], release: ["\\\\byou can push\\\\b"], blocks: ["\\\\bgit\\\\s+push\\\\b"] });
    fs.writeFileSync(file, JSON.stringify(rules, null, 2) + "\\n");
    return out(JSON.stringify({ change: "Adds a no-push constraint rule that refuses git push while it is active." }));
  }
  out("{}");
});`);
      writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${ghLog}"\ncase "$1 $2" in\n"pr list") echo "[]";;\n"api -X") echo '{"total_count":0}';;\n"pr create") echo "https://github.com/acme/skills/pull/42";;\n*) echo ok;;\nesac\n`);
      chmodSync(join(bin, "claude"), 0o755); chmodSync(join(bin, "gh"), 0o755);
      const env = { ...process.env, FLOW_FEEDBACK_HOME: home, FLOW_CLAUDE_BIN: join(bin, "claude"), PATH: `${bin}:${process.env.PATH}`, FLOW_AUTO_IDLE_MIN: "0" };
      delete env.FLOW_FEEDBACK; delete env.FLOW_AUTO_CHILD;
      const run = spawnSync(process.execPath, [join(plugin, "learn/auto.mjs"), "--print"], { env, encoding: "utf8", timeout: 590_000 });
      const out = JSON.parse(run.stdout || "{}");
      const done = out.done ?? [];
      assert.equal(done.length, 1, `${run.stdout}\n${run.stderr}`);
      assert.equal(done[0].outcome, "pr", JSON.stringify(done[0]));
      assert.equal(done[0].verdict, "enforced");
      assert.equal(done[0].url, "https://github.com/acme/skills/pull/42");
      // The PR branch on the "GitHub" side holds the rule and the case, nothing else.
      const files = execFileSync("git", ["-C", bare, "diff", "--name-only", "master", "flow-learn/unauthorized-action--push"], { encoding: "utf8" }).trim().split("\n");
      assert.ok(files.includes("plugins/flow/hooks/constraint-rules.json"), files.join(", "));
      assert.ok(files.every((f) => f === "plugins/flow/hooks/constraint-rules.json" || f.startsWith("plugins/flow/learn/cases/auto-")), files.join(", "));
      const gh = readFileSync(ghLog, "utf8");
      assert.match(gh, /pr create .*--draft/);
      assert.doesNotMatch(gh, /I said don't push/, "engineer text never reaches GitHub");
      // An analyzer that repeats the engineer's words is refused before anything runs: no proof, no PR.
      const leakyHome = join(root, "store3");
      mkdirSync(join(leakyHome, "queue/pending"), { recursive: true });
      const leakyConfig = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      writeFileSync(join(leakyHome, "config.json"), JSON.stringify({ ...leakyConfig, autoLearn: { ...leakyConfig.autoLearn, cloneDir: join(root, "clone3") } }));
      for (const s of ["s1", "s2"]) writeFileSync(join(leakyHome, "queue/pending", `e-${s}.json`), JSON.stringify({ id: `e-${s}`, type: "prompt", at: "2026-10-19T09:00:00Z", session: s, repo: "web", kind: "correction", category: "unauthorized-action", keys: ["push"], text: "I said don't push it to the remote yet", objective: null }));
      const leaky = JSON.parse(spawnSync(process.execPath, [join(plugin, "learn/auto.mjs"), "--print"], { env: { ...env, FLOW_FEEDBACK_HOME: leakyHome, LEAKY: "1" }, encoding: "utf8", timeout: 300_000 }).stdout || "{}");
      assert.equal(leaky.done?.[0]?.outcome, "refused-private", JSON.stringify(leaky));
      assert.match(leaky.done[0].reasons.join(" "), /repeats 5\+ words from the engineer's sessions/);
      assert.doesNotMatch(execFileSync("git", ["-C", bare, "log", "-1", "--format=%B", "flow-learn/unauthorized-action--push"], { encoding: "utf8" }), /I said don't push/);
      // A sloppy fix (a rule that refuses every git command) is rejected by the gate: no PR.
      const sloppyHome = join(root, "store2");
      mkdirSync(join(sloppyHome, "queue/pending"), { recursive: true });
      writeFileSync(join(sloppyHome, "config.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, "config.json"), "utf8")), autoLearn: { ...JSON.parse(readFileSync(join(home, "config.json"), "utf8")).autoLearn, cloneDir: join(root, "clone2") } }));
      for (const s of ["s1", "s2"]) writeFileSync(join(sloppyHome, "queue/pending", `e-${s}.json`), JSON.stringify({ id: `e-${s}`, type: "prompt", at: "2026-10-19T09:00:00Z", session: s, repo: "web", kind: "correction", category: "unauthorized-action", keys: ["push"], text: "I said don't push it to the remote yet", objective: null }));
      const sloppy = JSON.parse(spawnSync(process.execPath, [join(plugin, "learn/auto.mjs"), "--print"], { env: { ...env, FLOW_FEEDBACK_HOME: sloppyHome, SLOPPY: "1" }, encoding: "utf8", timeout: 590_000 }).stdout || "{}");
      assert.equal(sloppy.done?.[0]?.outcome, "not-proven", JSON.stringify(sloppy));
      assert.equal(sloppy.done[0].url, undefined);
      // A second run has nothing new to do (no new incidents since the attempt).
      const again = JSON.parse(spawnSync(process.execPath, [join(plugin, "learn/auto.mjs"), "--print"], { env, encoding: "utf8", timeout: 120_000 }).stdout || "{}");
      assert.deepEqual(again.done, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
