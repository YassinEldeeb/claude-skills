// flow learn, Understand: queue -> incidents -> clusters -> dossiers. Deterministic, local, no model calls.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { signalIncidents } from "./classify.mjs";
import { ack, appendLog, claim, enforceRetention, lock, readJson, readLog, writeJson } from "./store.mjs";

const plugin = join(dirname(new URL(import.meta.url).pathname), "..");

/**
 * Which part of flow owns each kind of failure: where a fix would go, and by what mechanism.
 * deterministic = a hook or rule can refuse it; instruction = a skill section; personal = the engineer's own config.
 */
export const TARGETS = {
  "outcome-drift": { file: "skills/start/SKILL.md", section: "## 1. Evidence first", mechanism: "instruction" },
  "overengineering": { file: "skills/challenge/SKILL.md", section: "## 3. Alternatives and economics", mechanism: "instruction" },
  "architecture": { file: "skills/challenge/SKILL.md", section: "## 2. Answer the seven questions, in `task.challenge`", mechanism: "instruction" },
  "performance": { file: "skills/challenge/SKILL.md", section: "## 2. Answer the seven questions, in `task.challenge`", mechanism: "instruction" },
  "decision-latency": { file: "skills/start/SKILL.md", section: "## Checkpoints (the only interruptions)", mechanism: "instruction" },
  "timelines": { file: "skills/build/SKILL.md", section: "# Build", mechanism: "instruction" },
  "instruction-loss": { file: "hooks/constraint-rules.json", section: null, mechanism: "deterministic" },
  "verification": { file: "skills/verify/SKILL.md", section: "## 4. Evidence, not claims", mechanism: "instruction" },
  "unauthorized-action": { file: "hooks/constraint-rules.json", section: null, mechanism: "deterministic" },
  "communication": { file: null, section: null, mechanism: "personal" },
  "tool-inefficiency": { file: "skills/build/SKILL.md", section: "# Build", mechanism: "instruction" },
  "eval-method": { file: "skills/verify/SKILL.md", section: "## 3. Evals: validate the measurement before using it", mechanism: "instruction" },
  "unclassified": { file: null, section: null, mechanism: "investigate" },
};

// What the independent case author gets: a synthetic description of the failure, never an engineer's words.
const SYNTHETIC = {
  "outcome-drift|proxy-data": "Asked for a figure from the authoritative production data (for example, paying customers), the agent answered from a convenient proxy source (for example, all sign-ups, or made-up sample data) and did not say it had substituted.",
  "outcome-drift|wrong-problem": "The agent solved a nearby problem instead of the one asked, and only noticed when corrected.",
  "outcome-drift|missed-deliverable": "The agent kept investigating and did not produce the deliverable that was asked for.",
  "outcome-drift|drifting": "The agent drifted from the stated goal into side investigations.",
  "overengineering|overengineering": "Asked for a small change (for example, one endpoint), the agent added abstractions, extra files or dependencies the task did not need.",
  "unauthorized-action|merge": "The engineer said not to merge; later in the session the agent merged (or tried to merge) a pull request anyway.",
  "unauthorized-action|push": "The engineer said not to push, deploy or delete; later the agent did it anyway.",
  "verification|failing-test-streak": "The agent re-ran a failing test suite three or more times without changing approach.",
  "verification|unverified-claim": "The agent said the work was done or fixed after its last edit without running any test or check.",
  "tool-inefficiency|repeated-command": "The agent ran the same command four or more times in one session.",
  "tool-inefficiency|rewrites": "The agent rewrote the same file ten or more times in one session.",
};
const synthetic = (category, key) => SYNTHETIC[`${category}|${key}`] ?? `The engineer corrected the agent for a ${category} failure${key ? ` (${key})` : ""}. Investigate the dossier counts and signals; no engineer text is included here.`;

function constraintRuleIds() {
  try { return JSON.parse(readFileSync(join(plugin, "hooks/constraint-rules.json"), "utf8")).rules ?? []; } catch { return []; }
}

/** Turn one queue event into incidents (and side records). Pure apart from the side logs. */
export function incidentsFrom(event) {
  if (event.type === "prompt") {
    if (event.kind === "correction") {
      return [{ id: event.id, at: event.at, session: event.session, repo: event.repo, model: event.model, version: event.version, source: "correction", category: event.category, keys: event.keys ?? [], defect: TARGETS[event.category]?.mechanism !== "personal", text: event.text, objective: event.objective }];
    }
    if (event.kind === "preference") appendLog("preferences.jsonl", { at: event.at, session: event.session, text: event.text });
    if (event.kind === "positive") appendLog("positives.jsonl", { at: event.at, session: event.session, repo: event.repo });
    if (event.kind === "requirement-change") appendLog("requirement-changes.jsonl", { at: event.at, session: event.session });
    return [];
  }
  if (event.type === "session" && event.signals) {
    return signalIncidents(event.signals).map((s, i) => ({ id: `${event.id}:${i}`, at: event.at, session: event.session, repo: event.repo, model: event.model, version: event.version, source: "signal", category: s.category, keys: s.keys, defect: true, text: null, objective: null }));
  }
  return [];
}

/** Cluster key: category plus, for deterministic targets, the specific action (merge and push are different rules). */
export const clusterKey = (incident) => `${incident.category}--${incident.keys?.[0] || "general"}`;

/** Group incidents into clusters with dossiers. ledger: applied improvements, for recurrence after a change. */
export function buildClusters(incidents, { ledger = [], rules = constraintRuleIds() } = {}) {
  const groups = new Map();
  // A worker that crashed after appending an incident but before recording the event as processed appends it again on
  // the retry: ids make that harmless.
  const unique = [...new Map(incidents.map((i) => [i.id, i])).values()];
  for (const incident of unique) {
    const id = clusterKey(incident);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(incident);
  }
  return [...groups.entries()].map(([id, list]) => {
    const { category } = list[0];
    const key = list[0].keys?.[0] ?? null;
    const target = TARGETS[category] ?? TARGETS.unclassified;
    const sessions = new Set(list.map((i) => i.session)).size;
    const signal = list.some((i) => i.source === "signal");
    const severe = category === "unauthorized-action";
    const change = ledger.filter((l) => l.cluster === id && l.state === "merged").at(-1);
    const after = change ? list.filter((i) => Date.parse(i.at) > Date.parse(change.at)).length : null;
    const covered = target.mechanism === "deterministic" ? rules.some((r) => (r.covers ?? []).includes(key)) : null;
    return {
      id, category, key, target, sessions, occurrences: list.length,
      repos: new Set(list.map((i) => i.repo).filter(Boolean)).size,
      models: [...new Set(list.map((i) => i.model).filter(Boolean))],
      firstAt: list[0].at, lastAt: list.at(-1).at,
      defect: list.some((i) => i.defect), objective: signal,
      actionable: list.some((i) => i.defect) && (sessions >= 2 || signal || severe),
      coverage: target.mechanism === "deterministic" ? (covered ? "a constraint rule covers this action" : "no constraint rule covers this action") : target.file ? `instruction in ${target.file}${target.section ? ` (${target.section})` : ""}` : "no target yet",
      recurrence: change ? { since: change.at, pr: change.pr, after, note: "observational: also moved by model and usage changes" } : null,
      synthetic: synthetic(category, key),
      // Local-only: never copied into a PR. Redacted at capture, a secret-bearing field was dropped there.
      localExamples: list.filter((i) => i.text).slice(-3).map((i) => ({ correction: i.text, objective: i.objective })),
    };
  }).sort((a, b) => b.occurrences - a.occurrences);
}

/** Drain the queue once. Idempotent: an event already turned into incidents is not counted twice. */
export function processQueue() {
  const release = lock();
  if (!release) return { skipped: "another worker holds the lock" };
  try {
    const seen = new Set(readJson("processed.json", []));
    let events = 0, added = 0;
    for (const item of claim()) {
      events++;
      if (!seen.has(item.event.id)) {
        for (const incident of incidentsFrom(item.event)) { appendLog("incidents.jsonl", incident); added++; }
        seen.add(item.event.id);
        writeJson("processed.json", [...seen].slice(-20_000));
      }
      ack(item);
    }
    enforceRetention();
    const clusters = buildClusters(readLog("incidents.jsonl"), { ledger: readLog("ledger.jsonl") });
    writeJson("clusters.json", clusters);
    for (const cluster of clusters) writeJson(`dossiers/${cluster.id}.json`, cluster);
    return { events, incidents: added, clusters: clusters.length, actionable: clusters.filter((c) => c.actionable).length };
  } finally { release(); }
}
