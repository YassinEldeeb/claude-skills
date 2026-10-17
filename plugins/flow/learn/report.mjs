// flow learn: the report. Every number says where it comes from: measured, estimated, synthetic or unavailable.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyPrompt } from "./classify.mjs";
import { readJson, readLog } from "./store.mjs";

const here = dirname(new URL(import.meta.url).pathname);

/** Precision and recall of the lexicon per kind, on the labelled synthetic set (learn/labelled.json). */
export function lexiconQuality() {
  const set = JSON.parse(readFileSync(join(here, "labelled.json"), "utf8"));
  const kinds = [...new Set(set.map((x) => x.kind))];
  const out = {};
  for (const kind of kinds) {
    let tp = 0, fp = 0, fn = 0;
    for (const example of set) {
      const got = classifyPrompt(example.text)?.kind ?? "none";
      if (got === kind && example.kind === kind) tp++;
      else if (got === kind) fp++;
      else if (example.kind === kind) fn++;
    }
    out[kind] = { precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null, n: set.filter((x) => x.kind === kind).length };
  }
  let categoryHits = 0, categoryTotal = 0;
  for (const example of set.filter((x) => x.category)) { categoryTotal++; if (classifyPrompt(example.text)?.category === example.category) categoryHits++; }
  return { kinds: out, categoryAccuracy: categoryTotal ? categoryHits / categoryTotal : null, size: set.length };
}

const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

export function report() {
  const sessions = readLog("sessions.jsonl");
  const incidents = readLog("incidents.jsonl");
  const corrections = incidents.filter((i) => i.source === "correction");
  const signals = incidents.filter((i) => i.source === "signal");
  const ledger = readLog("ledger.jsonl");
  const latency = readLog("hook-latency.jsonl").map((r) => r.ms);
  const evals = readLog("evals.jsonl");
  const clusters = readJson("clusters.json", []);
  const positives = readLog("positives.jsonl").length;
  const quality = lexiconQuality();
  const latest = new Map();
  for (const entry of ledger) latest.set(entry.url ?? `${entry.cluster}:${entry.state}`, entry);
  const states = {};
  for (const entry of latest.values()) states[entry.state] = (states[entry.state] ?? 0) + 1;
  const merged = states.merged ?? 0, reverted = states.reverted ?? 0;
  const withCorrection = new Set(corrections.map((c) => c.session));
  const recall = quality.kinds.correction?.recall;
  const rows = [
    ["Sessions recorded", sessions.length, "measured (SessionEnd)"],
    ["Corrections per 100 sessions", sessions.length ? +(100 * corrections.length / sessions.length).toFixed(1) : "unavailable", sessions.length ? `estimated: the lexicon finds ${recall != null ? Math.round(recall * 100) : "?"}% of corrections on the labelled synthetic set` : "no sessions yet"],
    ["Sessions with no correction", sessions.length ? `${sessions.filter((s) => !withCorrection.has(s.session)).length}/${sessions.length}` : "unavailable", "measured (same lexicon caveat)"],
    ["Objective signals", signals.length, "measured from transcripts at session end"],
    ["Positive feedback", positives, "measured (lexicon)"],
    ["Clusters (actionable)", `${clusters.length} (${clusters.filter((c) => c.actionable).length})`, "measured"],
    ["Proposals: review-only / proposed / merged / reverted", `${states["review-only"] ?? 0} / ${states.proposed ?? 0} / ${merged} / ${reverted}`, "measured (local ledger; `report --refresh` reads PR states)"],
    ["Regression rate (reverted / merged)", merged ? `${reverted}/${merged}` : "unavailable", merged ? "measured" : "nothing merged yet"],
    ["Prompt hook latency p50 / p95", latency.length ? `${quantile(latency, 0.5)} ms / ${quantile(latency, 0.95)} ms` : "unavailable", latency.length ? `measured inside the hook over ${latency.length} prompts, module loading included; Node's own startup (tens of ms, more under load) comes on top` : "no prompts recorded"],
    ["Eval spend", evals.length ? `$${evals.reduce((s, e) => s + (e.usd ?? 0), 0).toFixed(2)} over ${evals.length} prove run(s)` : "$0 (no behavioral evals run)", "measured (result JSON)"],
    ["First-attempt task success", "unavailable", "needs outcome labels flow does not collect"],
    ["Time to verified outcome", "unavailable", "needs outcome labels flow does not collect"],
  ];
  const lines = ["# flow learn report", "", "| Metric | Value | Source |", "|---|---|---|", ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`)];
  if (clusters.length) {
    lines.push("", "## Clusters", "", "| Cluster | Occurrences | Sessions | Actionable | Coverage | Recurrence after a change |", "|---|---|---|---|---|---|",
      ...clusters.map((c) => `| ${c.id} | ${c.occurrences} | ${c.sessions} | ${c.actionable ? "yes" : "no"} | ${c.coverage} | ${c.recurrence ? `${c.recurrence.after} since ${c.recurrence.since.slice(0, 10)} (observational)` : "-"} |`));
  }
  lines.push("", `Lexicon on the labelled synthetic set (${quality.size} prompts): ${Object.entries(quality.kinds).map(([k, v]) => `${k} P=${v.precision?.toFixed(2) ?? "-"} R=${v.recall?.toFixed(2) ?? "-"}`).join(", ")}; category accuracy ${quality.categoryAccuracy?.toFixed(2) ?? "-"} (synthetic).`);
  return lines.join("\n");
}
