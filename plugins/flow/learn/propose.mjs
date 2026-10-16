// flow learn, Propose: one draft PR per cluster, only after the effectiveness gate passed. Never merges, never approves.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeMarkdown } from "../gate/lib.mjs";
import { appendLog, readLog, writeJson } from "./store.mjs";

/** The only files a learned improvement may change. Gates, hook code, the harness, workflows and config are off limits. */
export const ALLOWED = [
  /^plugins\/flow\/skills\/[^/]+\/SKILL\.md$/,
  /^plugins\/flow\/templates\/rules\.md$/,
  /^plugins\/flow\/hooks\/constraint-rules\.json$/,
  /^plugins\/flow\/learn\/cases\/[^/]+\/.+/,
];
export const refusedPaths = (files) => files.filter((file) => !ALLOWED.some((re) => re.test(file)));
export const isEnforcement = (files) => files.some((file) => /constraint-rules\.json$/.test(file));

// gh subcommands the worker may run. Anything else (merge, review, approve, api writes) throws.
const GH_ALLOWED = [["pr", "create"], ["pr", "edit"], ["pr", "view"], ["pr", "list"], ["label", "create"], ["api", "-X", "GET"]];
export function ghArgsAllowed(args) { return GH_ALLOWED.some((prefix) => prefix.every((part, i) => args[i] === part)); }
export function gh(args, { cwd, input } = {}) {
  if (!ghArgsAllowed(args)) throw new Error(`flow-learn may not run: gh ${args.slice(0, 3).join(" ")}`);
  return execFileSync("gh", args, { cwd, input, encoding: "utf8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] });
}

const pct = (r) => (r?.n ? `${r.k}/${r.n} (${Math.round((100 * r.k) / r.n)}%)` : "not run");

/** The PR body: synthetic reproduction only, every dossier field escaped, raw counts and intervals, limits stated. */
export function prBody({ cluster, rootCause, change, results, judgement, cases }) {
  const e = escapeMarkdown;
  const lines = [
    `Learned improvement for cluster \`${e(cluster.id)}\`: ${cluster.occurrences} occurrence(s) across ${cluster.sessions} session(s) and ${cluster.repos} repo(s), ${e(cluster.firstAt?.slice(0, 10))} to ${e(cluster.lastAt?.slice(0, 10))}.`,
    "",
    "## The failure (synthetic reproduction)",
    e(cluster.synthetic),
    "",
    "_No engineer text, transcript or code from the incidents is included. Examples stay on the engineers' machines._",
    "",
    "## Root cause",
    e(rootCause),
    "",
    "## The change",
    e(change),
    "",
    "## Regression cases",
    ...cases.map((c) => `- \`plugins/flow/learn/cases/${e(c.id)}\` (${c.kind}${c.author ? `, written by ${e(c.author)}` : ""})`),
    "",
    "## Baseline vs candidate",
  ];
  if (judgement.tier === "deterministic") {
    const t = results.target;
    lines.push("Real hook scripts from each tree, on every fixture (blocked, allowed and held-out bypass attempts).", "", "| Fixture | Baseline | Candidate |", "|---|---|---|",
      ...t.arms.baseline.map((r, i) => `| ${e(r.name)}${r.heldOut ? " (held out)" : ""} | ${r.ok ? "✅" : "❌"} ${r.got} | ${t.arms.candidate[i].ok ? "✅" : "❌"} ${t.arms.candidate[i].got} |`));
  } else {
    lines.push(`\`claude -p --plugin-dir\` (real skill loading), model ${e(results.target.model)}, ${results.target.runsPerPrompt} run(s) per phrasing per arm.`, "",
      "| | Baseline | Candidate |", "|---|---|---|",
      `| All phrasings | ${pct(judgement.all?.baseline)} | ${pct(judgement.all?.candidate)} |`,
      `| Held-out phrasing | ${pct(judgement.heldOut?.baseline)} | ${pct(judgement.heldOut?.candidate)} |`,
      `| Tokens per run (mean) | ${Math.round(judgement.tokens?.baseline ?? 0)} | ${Math.round(judgement.tokens?.candidate ?? 0)} |`,
      `| Seconds per run (mean) | ${Math.round((judgement.ms?.baseline ?? 0) / 1000)} | ${Math.round((judgement.ms?.candidate ?? 0) / 1000)} |`, "",
      `90% interval of the held-out difference: [${judgement.heldOut?.interval?.map((x) => x.toFixed(2)).join(", ")}].`);
  }
  lines.push("", "## Verdict", `**${judgement.verdict}**${judgement.reasons?.length ? `: ${judgement.reasons.map(e).join("; ")}` : ""}`, "",
    "## Risks and limits",
    "- Measured on synthetic cases; real sessions differ. Recurrence of this cluster after merge is tracked by `flow-learn report` (observational).",
    judgement.tier === "deterministic" ? "- Hook enforcement is best effort (an agent can find a command the patterns miss); GitHub's required checks stay the hard layer." : "- Behavioral results carry sampling noise; the interval above is the honest size of the effect.",
    "",
    "**Human review required.** flow-learn never merges or approves; enforcement changes are labelled `enforcement`.");
  return lines.join("\n");
}

const today = () => new Date().toISOString().slice(0, 10);

/** Open or update the cluster's draft PR. repo: owner/name; dir: a checkout of the skills repo with the candidate. */
export function propose({ dir, repo, base, cluster, rootCause, change, results, judgement, cases, limits = { maxNewPrsPerDay: 2, maxOpenPrs: 5 } }) {
  if (!["improved", "enforced"].includes(judgement.verdict)) throw new Error(`not proposing: the verdict is "${judgement.verdict}" (${judgement.reasons?.join("; ")})`);
  const files = execFileSync("git", ["-C", dir, "diff", "--name-only", base], { encoding: "utf8" }).split("\n").filter(Boolean)
    .concat(execFileSync("git", ["-C", dir, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean));
  const refused = refusedPaths(files);
  if (refused.length) throw new Error(`a learned improvement may not change: ${refused.join(", ")}`);
  if (!files.length) throw new Error("the candidate changes nothing");
  const branch = `flow-learn/${cluster.id}`;
  execFileSync("git", ["-C", dir, "checkout", "-q", "-B", branch], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "add", "--", ...files]);
  execFileSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", `flow-learn: ${cluster.id}\n\n${change}`]);
  execFileSync("git", ["-C", dir, "push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`], { stdio: "ignore", timeout: 120_000 });

  const body = prBody({ cluster, rootCause, change, results, judgement, cases });
  const bodyFile = join(mkdtempSync(join(tmpdir(), "flow-pr-")), "body.md");
  writeFileSync(bodyFile, body);
  try {
    const existing = JSON.parse(gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url"], { cwd: dir }));
    let url;
    if (existing.length) {
      gh(["pr", "edit", String(existing[0].number), "--repo", repo, "--body-file", bodyFile], { cwd: dir });
      url = existing[0].url;
    } else {
      const open = JSON.parse(gh(["api", "-X", "GET", "search/issues", "-f", `q=repo:${repo} is:pr is:open label:flow-learn`], { cwd: dir })).total_count;
      const created = JSON.parse(gh(["api", "-X", "GET", "search/issues", "-f", `q=repo:${repo} is:pr label:flow-learn created:>=${today()}`], { cwd: dir })).total_count;
      if (open >= limits.maxOpenPrs) throw new Error(`rate limit: ${open} flow-learn PRs are open (max ${limits.maxOpenPrs}); review those first`);
      if (created >= limits.maxNewPrsPerDay) throw new Error(`rate limit: ${created} flow-learn PRs opened today (max ${limits.maxNewPrsPerDay})`);
      const labels = ["flow-learn", ...(isEnforcement(files) ? ["enforcement"] : [])];
      for (const label of labels) { try { gh(["label", "create", label, "--repo", repo, "--color", label === "enforcement" ? "B60205" : "5319E7", "--description", "flow learned improvement"], { cwd: dir }); } catch { /* exists */ } }
      url = gh(["pr", "create", "--repo", repo, "--draft", "--base", base.replace(/^origin\//, ""), "--head", branch, "--title", `flow-learn: ${cluster.category} (${cluster.key ?? "general"})`, "--body-file", bodyFile, ...labels.flatMap((l) => ["--label", l])], { cwd: dir }).trim();
    }
    appendLog("ledger.jsonl", { at: new Date().toISOString(), cluster: cluster.id, state: "proposed", url, verdict: judgement.verdict, files });
    return { url, files, body };
  } finally { rmSync(join(bodyFile, ".."), { recursive: true, force: true }); }
}

/** No PR: a local review-only proposal, when the gate did not show an improvement (or spend was not approved). */
export function reviewOnly({ cluster, rootCause, change, judgement, plan }) {
  const record = { at: new Date().toISOString(), cluster: cluster.id, state: "review-only", verdict: judgement?.verdict ?? "not-run", reasons: judgement?.reasons ?? [], rootCause, change, plan };
  writeJson(`proposals/${cluster.id}.json`, record);
  appendLog("ledger.jsonl", { at: record.at, cluster: cluster.id, state: "review-only", verdict: record.verdict });
  return record;
}

/** Roll back a merged improvement: a draft revert PR. The merge decision stays human. */
export function rollback({ dir, repo, pr, base }) {
  const info = JSON.parse(gh(["api", "-X", "GET", `repos/${repo}/pulls/${pr}`], { cwd: dir }));
  if (!info.merged_at) throw new Error(`PR #${pr} is not merged`);
  const branch = `flow-learn/revert-${pr}`;
  execFileSync("git", ["-C", dir, "fetch", "-q", "origin"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "checkout", "-q", "-B", branch, base], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "revert", "--no-edit", info.merge_commit_sha], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`], { stdio: "ignore", timeout: 120_000 });
  const url = gh(["pr", "create", "--repo", repo, "--draft", "--base", base.replace(/^origin\//, ""), "--head", branch, "--title", `Revert learned improvement #${pr}`, "--body", `Reverts #${pr} (${escapeMarkdown(info.title)}). Opened by \`flow-learn rollback\`; merging is a human decision.`, "--label", "flow-learn"], { cwd: dir }).trim();
  appendLog("ledger.jsonl", { at: new Date().toISOString(), cluster: readLog("ledger.jsonl").find((l) => l.url?.endsWith(`/${pr}`))?.cluster ?? null, state: "revert-proposed", url, of: pr });
  return { url };
}
