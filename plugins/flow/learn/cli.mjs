#!/usr/bin/env node
// flow-learn: the engineer's interface to flow's learning loop. Capture and Understand run on their own (hooks + the
// deterministic worker); Improve and Prove are explicit; nothing here merges, approves or spends without being told to.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CASES_DIR, baselineTree, calibrate, changedFiles, estimate, judge, listCases, loadCase, runBehavioral, runDeterministic, sizeGrowth } from "./prove.mjs";
import { propose, reviewOnly, rollback } from "./propose.mjs";
import { report } from "./report.mjs";
import { appendLog, config, home, path, queueCounts, readJson, readLog, saveConfig, writeLog } from "./store.mjs";
import { processQueue } from "./worker.mjs";

const USAGE = `flow-learn
  status                     Is capture on, what is queued, how many clusters
  inspect [--all]            What is stored locally (incidents, clusters); --all includes raw queue events
  delete --all | --session ID | --before YYYY-MM-DD
                             Delete stored data
  disable | enable           Turn local capture off or on (enable also opts in where a repo asks for opt-in)
  process [--quiet]          Drain the queue into incidents, clusters and dossiers (deterministic, no model calls)
  clusters                   The clusters, most frequent first
  dossier ID                 One cluster's dossier (what /flow:learn starts from)
  prove CASE... --candidate DIR [--base REF] [--suite] [--runs N] [--model M] [--approve-spend --budget-usd X] [--json FILE]
                             Baseline vs candidate. Deterministic cases always run (free). Behavioral cases run only
                             with --approve-spend and a budget at least the printed estimate.
  propose CLUSTER --candidate DIR --results FILE --repo OWNER/NAME [--base REF] [--root-cause TEXT] [--change TEXT]
                             Open or update the cluster's draft PR (only if the results' verdict is improved/enforced)
  rollback PR --candidate DIR --repo OWNER/NAME [--base REF]
                             Open a draft PR reverting a merged improvement
  report                     The measurement report`;

const args = process.argv.slice(2);
const command = args[0];
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const VALUE = ["--candidate", "--base", "--runs", "--model", "--budget-usd", "--json", "--results", "--repo", "--root-cause", "--change", "--session", "--before"];
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
    if (flag("all")) { rmSync(home(), { recursive: true, force: true }); return print(`deleted ${home()}`); }
    const session = opt("session"), before = opt("before");
    if (!session && !before) throw new Error("delete --all | --session ID | --before YYYY-MM-DD");
    const keep = (r) => (session ? r.session !== session : true) && (before ? !(r.at && r.at < before) : true);
    let removed = 0;
    for (const name of ["incidents.jsonl", "sessions.jsonl", "preferences.jsonl", "positives.jsonl", "constraints.jsonl", "requirement-changes.jsonl"]) {
      const all = readLog(name), kept = all.filter(keep);
      removed += all.length - kept.length;
      if (existsSync(path(name))) writeLog(name, kept);
    }
    if (session && existsSync(path("sessions", `${session}.json`))) rmSync(path("sessions", `${session}.json`));
    processQueue();
    print(`deleted ${removed} record(s); clusters rebuilt`);
  },
  disable() { saveConfig({ ...config(), capture: false }); print("capture disabled (stored data kept; `delete --all` removes it)"); },
  enable() { saveConfig({ ...config(), capture: true, enabledAt: new Date().toISOString() }); print("capture enabled (local only)"); },
  process() { const r = processQueue(); if (!flag("quiet")) print(r); },
  clusters() { print(readJson("clusters.json", []).map(({ localExamples, ...c }) => c)); },
  dossier() {
    const [id] = positional();
    const d = readJson(`dossiers/${id}.json`, null);
    if (!d) throw new Error(`no dossier ${id}; run \`flow-learn process\`, then \`flow-learn clusters\``);
    print(d);
  },
  async prove() {
    const candidate = opt("candidate");
    if (!candidate) throw new Error("--candidate DIR (a checkout of the skills repo with the change)");
    const base = opt("base", "origin/master");
    const named = positional().map(loadCase);
    const suite = flag("suite") ? listCases().filter((c) => !named.some((n) => n.id === c.id)) : [];
    const runs = Number(opt("runs", config().eval.runs));
    const model = opt("model", config().eval.model ?? "sonnet");
    const behavioral = [...named, ...suite].filter((c) => c.kind === "behavioral");
    const cost = estimate(behavioral, { runs, model });
    const approved = flag("approve-spend") && Number(opt("budget-usd", 0)) >= cost.usd;
    const tree = baselineTree(candidate, base);
    const out = { base, candidate, estimate: cost, cases: [] };
    try {
      const growth = sizeGrowth(tree.dir, candidate, changedFiles(candidate, base).filter((f) => f.endsWith("SKILL.md") || f.endsWith("rules.md")));
      const spent = { usd: 0 };
      const results = new Map();
      for (const c of [...named, ...suite]) {
        if (c.kind === "deterministic") results.set(c.id, runDeterministic(c, { baseline: tree.dir, candidate }));
        else if (approved) results.set(c.id, await runBehavioral(c, { baseline: tree.dir, candidate, runs, model, budget: Number(opt("budget-usd")), spent }));
      }
      for (const c of named) {
        const target = results.get(c.id);
        const calibration = c.kind === "behavioral" ? await calibrate(c) : null;
        if (!target) {
          out.cases.push({ case: c.id, calibration, judgement: { verdict: "not-run", reasons: [`behavioral: needs --approve-spend --budget-usd ${cost.usd} (${cost.runs} runs on ${model}, ${cost.basis})`] } });
          continue;
        }
        const judgement = judge({ target, suite: suite.map((s) => results.get(s.id)).filter((r) => r && r.tier === target.tier), calibration, growth });
        out.cases.push({ case: c.id, calibration, judgement, target });
      }
      out.spent = spent.usd;
      if (spent.usd) appendLog("evals.jsonl", { at: new Date().toISOString(), cases: named.map((c) => c.id), usd: spent.usd, model });
    } finally { tree.remove(); }
    if (opt("json")) writeFileSync(opt("json"), JSON.stringify(out, null, 2));
    print(out.cases.map(({ target, ...rest }) => rest));
    print(`estimate for behavioral cases: ${cost.runs} runs, ~$${cost.usd} (${cost.basis}); spent $${(out.spent ?? 0).toFixed(2)}`);
    return out.cases.every((c) => ["improved", "enforced"].includes(c.judgement.verdict)) ? 0 : 1;
  },
  propose() {
    const [clusterId] = positional();
    const cluster = readJson(`dossiers/${clusterId}.json`, null);
    if (!cluster) throw new Error(`no dossier ${clusterId}`);
    const results = JSON.parse(readFileSync(opt("results"), "utf8"));
    const first = results.cases[0];
    const repo = opt("repo");
    if (!repo) throw new Error("--repo OWNER/NAME");
    const verdictOk = results.cases.length && results.cases.every((c) => ["improved", "enforced"].includes(c.judgement.verdict));
    const rootCause = opt("root-cause", "(see the dossier)"), change = opt("change", "(see the diff)");
    if (!verdictOk) return print(reviewOnly({ cluster, rootCause, change, judgement: first?.judgement, plan: results.estimate }));
    const cases = results.cases.map((c) => loadCase(c.case));
    print(propose({ dir: opt("candidate"), repo, base: opt("base", "origin/master"), cluster, rootCause, change, results: { target: first.target }, judgement: first.judgement, cases, limits: config() }));
  },
  rollback() {
    const [pr] = positional();
    print(rollback({ dir: opt("candidate"), repo: opt("repo"), pr: Number(pr), base: opt("base", "origin/master") }));
  },
  report() { print(report()); },
  cases() { print(existsSync(CASES_DIR) ? readdirSync(CASES_DIR) : []); },
};
const run = commands[command];
if (!run) { console.log(USAGE); process.exit(command ? 2 : 0); }
Promise.resolve().then(run).then((code) => process.exit(typeof code === "number" ? code : 0), (error) => { console.error(`flow-learn ${command}: ${error.message}`); process.exit(1); });
