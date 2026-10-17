// flow learn, Propose: one draft PR per cluster, only after the effectiveness gate passed. Never merges, never approves.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeMarkdown } from "../gate/lib.mjs";
import { baselineTree, judge, loadCase, runDeterministic, treeHash } from "./prove.mjs";
import { appendLog, readLog, writeJson } from "./store.mjs";

/**
 * The only files a learned improvement may change. Gates, hook code, the harness, workflows and config are off limits;
 * existing regression cases are too (the evaluator must not be editable by what it evaluates): only NEW case
 * directories, and learn/enforced.json only by adding ids.
 */
export const ALLOWED = [
  /^plugins\/flow\/skills\/[^/]+\/SKILL\.md$/,
  /^plugins\/flow\/templates\/rules\.md$/,
  /^plugins\/flow\/hooks\/constraint-rules\.json$/,
  /^plugins\/flow\/learn\/cases\/[a-z0-9-]+\/[^\0]+$/,
  /^plugins\/flow\/learn\/enforced\.json$/,
];
export const refusedPaths = (files) => files.filter((file) => !ALLOWED.some((re) => re.test(file)) || file.split("/").includes(".."));
const git = (dir, args, opts = {}) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
const existsAt = (dir, ref, path) => { try { git(dir, ["cat-file", "-e", `${ref}:${path}`]); return true; } catch { return false; } };

/** Every path that differs from base: working tree, index and untracked files, renames split into delete + add. */
export function changedPaths(dir, base) {
  const lines = (args) => git(dir, args).split("\n").filter(Boolean);
  return [...new Set([
    ...lines(["diff", "--name-only", "--no-renames", base]),
    ...lines(["diff", "--name-only", "--no-renames", "--cached", base]),
    ...lines(["ls-files", "--others", "--exclude-standard"]),
  ])].sort();
}

/** Problems with a candidate's paths: disallowed files, edits to existing cases, enforced.json losing ids. */
export function pathProblems(dir, base, files) {
  const problems = refusedPaths(files).map((f) => `may not change ${f}`);
  for (const caseDir of new Set(files.map((f) => /^plugins\/flow\/learn\/cases\/([^/]+)\//.exec(f)?.[1]).filter(Boolean))) {
    if (existsAt(dir, base, `plugins/flow/learn/cases/${caseDir}`)) problems.push(`may not change the existing case ${caseDir} (add a new case instead)`);
  }
  if (files.includes("plugins/flow/learn/enforced.json")) {
    const before = existsAt(dir, base, "plugins/flow/learn/enforced.json") ? JSON.parse(git(dir, ["show", `${base}:plugins/flow/learn/enforced.json`])) : [];
    let after = [];
    try { after = JSON.parse(readFileSync(join(dir, "plugins/flow/learn/enforced.json"), "utf8")); } catch { problems.push("learn/enforced.json is not valid JSON"); }
    const lost = before.filter((id) => !after.includes(id));
    if (lost.length) problems.push(`learn/enforced.json may only gain ids (would drop ${lost.join(", ")})`);
  }
  return problems;
}
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
    ...cases.map((c) => `- \`plugins/flow/learn/cases/${e(c.id)}\` (${c.kind}${c.author ? `; author as recorded in the case, not verified: ${e(c.author)}` : ""})`),
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

/**
 * Re-check the evidence instead of trusting a results file: deterministic cases are re-run here against the base;
 * behavioral results must carry this exact tree's hash and base. Returns { judgement, target, problems }.
 */
export function verifyEvidence({ dir, base, cluster, results }) {
  const problems = [];
  const baseSha = git(dir, ["rev-parse", base]).trim();
  const cases = (results.cases ?? []).map((c) => loadCase(join(dir, "plugins/flow/learn/cases", c.case)));
  if (!cases.length) return { problems: ["the results name no case"] };
  for (const c of cases) if (c.cluster !== cluster.id) problems.push(`case ${c.id} belongs to cluster ${c.cluster}, not ${cluster.id}`);
  const deterministic = cases.filter((c) => c.kind === "deterministic");
  let judgement = null, target = null;
  if (deterministic.length) {
    const tree = baselineTree(dir, baseSha);
    try {
      for (const c of deterministic) {
        const t = runDeterministic(c, { baseline: tree.dir, candidate: dir });
        const j = judge({ target: t });
        if (j.verdict !== "enforced") problems.push(`re-run of ${c.id}: ${j.verdict} (${j.reasons.join("; ")})`);
        judgement ??= j; target ??= t;
      }
    } finally { tree.remove(); }
  }
  if (cases.some((c) => c.kind === "behavioral")) {
    if (results.treeHash !== treeHash(dir)) problems.push("the behavioral results are for a different tree than this candidate (re-run prove)");
    if (results.baseSha !== baseSha) problems.push("the behavioral results were measured against a different base");
    const bad = (results.cases ?? []).filter((c) => c.judgement?.verdict !== "improved");
    if (bad.length) problems.push(`behavioral verdicts: ${bad.map((c) => `${c.case}: ${c.judgement?.verdict}`).join(", ")}`);
    judgement ??= results.cases.find((c) => c.judgement)?.judgement; target ??= results.cases.find((c) => c.target)?.target;
  }
  return { judgement, target, problems, cases, baseSha };
}

/** Open or update the cluster's draft PR. repo: owner/name; dir: a checkout of the skills repo with the candidate. */
export function propose({ dir, repo, base, cluster, rootCause, change, results, limits = { maxNewPrsPerDay: 2, maxOpenPrs: 5 } }) {
  const evidence = verifyEvidence({ dir, base, cluster, results });
  if (evidence.problems.length) throw new Error(`not proposing: ${evidence.problems.join("; ")}`);
  const files = changedPaths(dir, base);
  if (!files.length) throw new Error("the candidate changes nothing");
  const problems = pathProblems(dir, base, files);
  if (problems.length) throw new Error(`a learned improvement ${problems.join("; ")}`);
  const branch = `flow-learn/${cluster.id.replace(/[^a-z0-9-]/g, "")}`;
  const existing = JSON.parse(gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url"], { cwd: dir }));
  if (!existing.length) {
    const open = JSON.parse(gh(["api", "-X", "GET", "search/issues", "-f", `q=repo:${repo} is:pr is:open label:flow-learn`], { cwd: dir })).total_count;
    const created = JSON.parse(gh(["api", "-X", "GET", "search/issues", "-f", `q=repo:${repo} is:pr label:flow-learn created:>=${today()}`], { cwd: dir })).total_count;
    if (open >= limits.maxOpenPrs) throw new Error(`rate limit: ${open} flow-learn PRs are open (max ${limits.maxOpenPrs}); review those first`);
    if (created >= limits.maxNewPrsPerDay) throw new Error(`rate limit: ${created} flow-learn PRs opened today (max ${limits.maxNewPrsPerDay})`);
  }
  // The commit holds exactly the vetted files, built in a temporary index: the engineer's checkout is never switched,
  // and nothing else that happens to be staged or modified rides along.
  const tmp = mkdtempSync(join(tmpdir(), "flow-pr-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
  try {
    git(dir, ["read-tree", evidence.baseSha], { env });
    for (const file of files) {
      try { readFileSync(join(dir, file)); git(dir, ["add", "--", file], { env }); } catch { git(dir, ["rm", "-q", "--cached", "--ignore-unmatch", "--", file], { env }); }
    }
    const tree = git(dir, ["write-tree"], { env }).trim();
    const commit = git(dir, ["-c", "user.name=flow-learn", "-c", "user.email=flow-learn@localhost", "commit-tree", tree, "-p", evidence.baseSha, "-m", `flow-learn: ${cluster.id}\n\n${change}`], { env }).trim();
    git(dir, ["push", "-q", "-f", "origin", `${commit}:refs/heads/${branch}`], { timeout: 120_000 });
    const body = prBody({ cluster, rootCause, change, results: { target: evidence.target }, judgement: evidence.judgement, cases: evidence.cases });
    const bodyFile = join(tmp, "body.md");
    writeFileSync(bodyFile, body);
    let url;
    if (existing.length) {
      gh(["pr", "edit", String(existing[0].number), "--repo", repo, "--body-file", bodyFile], { cwd: dir });
      url = existing[0].url;
    } else {
      const labels = ["flow-learn", ...(isEnforcement(files) ? ["enforcement"] : [])];
      for (const label of labels) { try { gh(["label", "create", label, "--repo", repo, "--color", label === "enforcement" ? "B60205" : "5319E7", "--description", "flow learned improvement"], { cwd: dir }); } catch { /* exists */ } }
      const title = `flow-learn: ${cluster.category.replace(/[^a-z0-9-]/g, "")} (${String(cluster.key ?? "general").replace(/[^a-z0-9-]/g, "")})`;
      url = gh(["pr", "create", "--repo", repo, "--draft", "--base", base.replace(/^origin\//, ""), "--head", branch, "--title", title, "--body-file", bodyFile, ...labels.flatMap((l) => ["--label", l])], { cwd: dir }).trim();
    }
    appendLog("ledger.jsonl", { at: new Date().toISOString(), cluster: cluster.id, state: "proposed", url, verdict: evidence.judgement?.verdict, files });
    return { url, files, body, commit };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
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
  const parents = execFileSync("git", ["-C", dir, "rev-list", "--parents", "-n", "1", info.merge_commit_sha], { encoding: "utf8" }).trim().split(" ").length - 1;
  execFileSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), info.merge_commit_sha], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`], { stdio: "ignore", timeout: 120_000 });
  const url = gh(["pr", "create", "--repo", repo, "--draft", "--base", base.replace(/^origin\//, ""), "--head", branch, "--title", `Revert learned improvement #${pr}`, "--body", `Reverts #${pr} (${escapeMarkdown(info.title)}). Opened by \`flow-learn rollback\`; merging is a human decision.`, "--label", "flow-learn"], { cwd: dir }).trim();
  appendLog("ledger.jsonl", { at: new Date().toISOString(), cluster: readLog("ledger.jsonl").find((l) => l.url?.endsWith(`/${pr}`))?.cluster ?? null, state: "revert-proposed", url, of: pr });
  return { url };
}
