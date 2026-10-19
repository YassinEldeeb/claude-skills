#!/usr/bin/env node
// flow-learn: the engineer's interface to flow's learning loop. Capture and Understand run on their own (hooks + the
// deterministic worker); Improve and Prove are explicit; nothing here merges, approves or spends without being told to.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { baselineTree, calibrate, changedFiles, estimate, judge, listCases, runBehavioral, runDeterministic, sizeGrowth, treeHash } from "./prove.mjs";
import { gh, propose, reviewOnly, rollback } from "./propose.mjs";
import { report } from "./report.mjs";
import { LOGS, appendLog, config, home, path, queueCounts, readJson, readLog, saveConfig, writeLog } from "./store.mjs";
import { processQueue } from "./worker.mjs";
import { autoConfig, run as autoRun } from "./auto.mjs";

const USAGE = `flow-learn
  status                     Is capture on, what is queued, how many clusters
  inspect [--all]            What is stored locally (incidents, clusters); --all includes raw queue events
  delete --all | --session ID | --before YYYY-MM-DD
                             Delete stored data
  disable | enable           Turn local capture off or on (enable also opts in where a repo asks for opt-in)
  process [--quiet]          Drain the queue into incidents, clusters and dossiers (deterministic, no model calls)
  clusters                   The clusters, most frequent first
  dossier ID                 One cluster's dossier (what /flow:learn starts from)
  prove CASE... --candidate DIR [--base REF] [--runs N] [--model M] [--approve-spend --budget-usd X] [--json FILE]
                             Baseline vs candidate, plus the rest of the suite (no-regression). Cases come from the
                             candidate checkout. Deterministic cases always run (free); behavioral ones only with
                             --approve-spend and a budget at least the printed estimate (the engineer approves spend).
  propose CLUSTER --candidate DIR --results FILE --repo OWNER/NAME [--base REF] [--pr-base BRANCH] [--root-cause TEXT] [--change TEXT]
                             Open or update the cluster's draft PR (only if the results' verdict is improved/enforced)
  rollback PR --candidate DIR --repo OWNER/NAME [--base REF]
                             Open a draft PR reverting a merged improvement
  report [--refresh]         The measurement report (--refresh reads proposed PRs' states from GitHub)
  auto status | on | off | run [--session ID] [--retry-now]
                             Auto-learn: after a correction, analyze, fix, prove and open a draft PR in the background
                             (opt-in; on and off are the engineer's; "flow auto-learn on" typed in a prompt does the same)`;

const args = process.argv.slice(2);
const command = args[0];
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const VALUE = ["--candidate", "--base", "--pr-base", "--runs", "--model", "--budget-usd", "--json", "--results", "--repo", "--root-cause", "--change", "--session", "--before"];
const positional = () => args.slice(1).filter((a, i, all) => !a.startsWith("--") && !VALUE.includes(all[i - 1]));
const print = (x) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));

const commands = {
  status() {
    const c = config();
    const clusters = readJson("clusters.json", []);
    print({ capture: process.env.FLOW_FEEDBACK === "off" ? "off (FLOW_FEEDBACK=off)" : c.capture === false ? "off (disabled)" : "on", store: home(), queue: queueCounts(), incidents: readLog("incidents.jsonl").length, clusters: clusters.length, actionable: clusters.filter((x) => x.actionable).map((x) => x.id) });
  },
  inspect() {
    print({ incidents: readLog("incidents.jsonl"), clusters: readJson("clusters.json", []), preferences: readLog("preferences.jsonl"), constraints: readLog("constraints.jsonl"), ...(flag("all") ? { queue: queueCounts() } : {}) });
  },
  delete() {
    if (flag("all")) {
      // Everything but config.json: deleting the data must not silently turn capture back on after `disable`.
      for (const name of existsSync(home()) ? readdirSync(home()) : []) if (name !== "config.json") rmSync(path(name), { recursive: true, force: true });
      return print(`deleted everything in ${home()} (kept config.json)`);
    }
    const session = opt("session")?.replace(/[^\w.-]/g, ""), before = opt("before");
    if (!session && !before) throw new Error("delete --all | --session ID | --before YYYY-MM-DD");
    processQueue(); // first, so a session's still-queued events are deleted too, not re-added afterwards
    const keep = (r) => (session ? r.session !== session : true) && (before ? !(r.at && r.at < before) : true);
    let removed = 0;
    for (const name of LOGS) {
      const all = readLog(name), kept = all.filter(keep);
      removed += all.length - kept.length;
      if (existsSync(path(name))) writeLog(name, kept);
    }
    if (session && existsSync(path("sessions", `${session}.json`))) rmSync(path("sessions", `${session}.json`));
    const rebuilt = processQueue();
    print(`deleted ${removed} record(s); ${rebuilt.skipped ? `clusters not rebuilt (${rebuilt.skipped}); run \`process\` again` : "clusters rebuilt"}`);
  },
  disable() { saveConfig({ ...config(), capture: false }); print("capture disabled (stored data kept; `delete --all` removes it)"); },
  enable() {
    // Opting in is per repo: a repo that asks for opt-in captures only once the engineer enabled it there.
    let repo = null;
    try { repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("/").pop(); } catch { /* not a repo */ }
    const c = config();
    saveConfig({ ...c, capture: true, enabledRepos: [...new Set([...(c.enabledRepos ?? []), ...(repo ? [repo] : [])])] });
    print(`capture enabled (local only)${repo ? `, including opt-in repo ${repo}` : ""}`);
  },
  process() { const r = processQueue(); if (!flag("quiet")) print(r); },
  clusters() { print(readJson("clusters.json", []).map(({ localExamples, ...c }) => c)); },
  dossier() {
    const id = positional()[0]?.replace(/[^a-z0-9-]/g, "");
    const d = readJson(`dossiers/${id}.json`, null);
    if (!d) throw new Error(`no dossier ${id}; run \`flow-learn process\`, then \`flow-learn clusters\``);
    print(d);
  },
  async prove() {
    if (!opt("candidate")) throw new Error("--candidate DIR (a checkout of the skills repo with the change)");
    // Absolute: case scorers are imported by path, and a relative one ("plugins/...") reads as a package name.
    const candidate = resolve(opt("candidate"));
    const base = opt("base", "origin/master");
    // Cases come from the candidate checkout, so a newly written case is found and existing ones are what it ships.
    const casesDir = join(candidate, "plugins/flow/learn/cases");
    const all = listCases(casesDir);
    const named = positional().map((id) => { const c = all.find((x) => x.id === id); if (!c) throw new Error(`no case ${id} in ${casesDir}`); return c; });
    const changed = changedFiles(candidate, base);
    const instructions = changed.some((f) => f.endsWith("SKILL.md") || f.endsWith("rules.md"));
    // The suite: every other deterministic case, and every behavioral case when instructions changed.
    const suiteCases = all.filter((c) => !named.includes(c) && (c.kind === "deterministic" || instructions));
    const runs = Number(opt("runs", config().eval.runs));
    const model = opt("model", config().eval.model ?? "sonnet");
    const behavioral = [...named, ...suiteCases].filter((c) => c.kind === "behavioral");
    const cost = estimate(behavioral, { runs, model });
    const approved = flag("approve-spend") && Number(opt("budget-usd", 0)) >= cost.usd;
    const tree = baselineTree(candidate, base);
    const out = { base, baseSha: execFileSync("git", ["-C", candidate, "rev-parse", base], { encoding: "utf8" }).trim(), treeHash: treeHash(candidate), candidate, estimate: cost, suite: suiteCases.map((c) => c.id), cases: [] };
    try {
      const growth = sizeGrowth(tree.dir, candidate, changed.filter((f) => f.endsWith("SKILL.md") || f.endsWith("rules.md")));
      const spent = { usd: 0 };
      const results = new Map();
      try {
        for (const c of [...named, ...suiteCases]) {
          if (c.kind === "deterministic") results.set(c.id, runDeterministic(c, { baseline: tree.dir, candidate }));
          else if (approved) results.set(c.id, await runBehavioral(c, { baseline: tree.dir, candidate, runs, model, budget: Number(opt("budget-usd")), spent }));
        }
      } finally {
        out.spent = spent.usd;
        if (spent.usd) appendLog("evals.jsonl", { at: new Date().toISOString(), cases: named.map((c) => c.id), usd: spent.usd, model });
      }
      for (const c of named) {
        const target = results.get(c.id);
        const calibration = c.kind === "behavioral" ? await calibrate(c) : null;
        if (!target) {
          out.cases.push({ case: c.id, calibration, judgement: { verdict: "not-run", reasons: [`behavioral: needs the engineer's spend approval, --approve-spend --budget-usd ${cost.usd} (${cost.runs} runs on ${model}, ${cost.basis})`] } });
          continue;
        }
        const judgement = judge({ target, suite: suiteCases.map((s) => results.get(s.id)).filter(Boolean), expectedSuite: suiteCases.map((s) => s.id), calibration, growth });
        out.cases.push({ case: c.id, calibration, judgement, target });
      }
      // The suite's own runs, so a regression the judgement reports can be read, not just trusted.
      out.suiteResults = suiteCases.map((s) => results.get(s.id)).filter(Boolean);
    } finally { tree.remove(); }
    const file = opt("json") ?? join(mkdtempSync(join(tmpdir(), "flow-prove-")), "results.json");
    writeFileSync(file, JSON.stringify(out, null, 2));
    print(out.cases.map(({ target, ...rest }) => rest));
    print(`behavioral estimate: ${cost.runs} runs, ~$${cost.usd} (${cost.basis}); spent $${(out.spent ?? 0).toFixed(2)}; results: ${file}`);
    return out.cases.every((c) => ["improved", "enforced"].includes(c.judgement.verdict)) ? 0 : 1;
  },
  propose() {
    const clusterId = positional()[0]?.replace(/[^a-z0-9-]/g, "");
    const cluster = readJson(`dossiers/${clusterId}.json`, null);
    if (!cluster) throw new Error(`no dossier ${clusterId}`);
    const results = JSON.parse(readFileSync(opt("results"), "utf8"));
    const repo = opt("repo");
    if (!repo) throw new Error("--repo OWNER/NAME");
    const rootCause = opt("root-cause", "(see the dossier)"), change = opt("change", "(see the diff)");
    try {
      // propose re-checks the evidence itself (re-runs deterministic cases, matches the tree hash); the file is a hint.
      print(propose({ dir: opt("candidate"), repo, base: opt("base", "origin/master"), ...(opt("pr-base") ? { prBase: opt("pr-base") } : {}), cluster, rootCause, change, results, limits: config() }));
    } catch (error) {
      if (!/^not proposing/.test(error.message)) throw error;
      print(reviewOnly({ cluster, rootCause, change, judgement: { verdict: "not proven", reasons: [error.message] }, plan: results.estimate }));
      return 1;
    }
  },
  rollback() {
    const [pr] = positional();
    print(rollback({ dir: opt("candidate"), repo: opt("repo"), pr: Number(pr), base: opt("base", "origin/master") }));
  },
  async auto() {
    const sub = positional()[0] ?? "status";
    if (sub === "on" || sub === "off") {
      const c = config();
      saveConfig({ ...c, autoLearn: { ...(c.autoLearn ?? {}), enabled: sub === "on" } });
      return print(`auto-learn ${sub}`);
    }
    if (sub === "run") return print(await autoRun({ session: opt("session"), ended: true, retryNow: flag("retry-now") }));
    print({ ...autoConfig(), recent: readLog("auto.jsonl").slice(-10) });
  },
  report() {
    if (flag("refresh")) {
      // A proposed PR's fate comes from GitHub; merged ones start the recurrence clock.
      const seen = new Set();
      for (const entry of readLog("ledger.jsonl").reverse()) {
        if (!["proposed", "revert-proposed"].includes(entry.state) || !entry.url || seen.has(entry.url)) continue;
        seen.add(entry.url);
        try {
          const pr = JSON.parse(gh(["pr", "view", entry.url, "--json", "state,mergedAt"]));
          const revert = entry.state === "revert-proposed";
          const state = pr.mergedAt ? (revert ? "reverted" : "merged") : pr.state === "CLOSED" ? (revert ? null : "rejected") : null;
          if (state) appendLog("ledger.jsonl", { at: pr.mergedAt ?? new Date().toISOString(), cluster: entry.cluster, state, url: entry.url });
        } catch { /* offline: keep what we know */ }
      }
    }
    print(report());
  },
};
const run = commands[command];
if (!run) { console.log(USAGE); process.exit(command ? 2 : 0); }
Promise.resolve().then(run).then((code) => process.exit(typeof code === "number" ? code : 0), (error) => { console.error(`flow-learn ${command}: ${error.message}`); process.exit(1); });
