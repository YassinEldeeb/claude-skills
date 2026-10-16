#!/usr/bin/env node
// flow CLI: the CI gate and the local tools around it. All GitHub I/O lives here; the rules live in lib.mjs.
// /flow:install copies this file into repos as .github/flow/flow.mjs.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLOW_VERSION, approveLine, configErrors, detectSignals, evaluate, parseApprovals, parseUnifiedDiff, checkToPost, render, signedMessage, specDocPaths, specHash, sshVerifier, taskErrors,
} from "./lib.mjs";

const USAGE = `flow ${FLOW_VERSION}
  check [--pr N] [--repo owner/name] [--post] [--config file]
        Run the gate. In CI (--post) it reads the event, then writes the "flow" check run and the PR's dashboard comment.
        Locally it prints what the gate would say; --config tries a local config (never with --post).
  status [ID...]      Each local task: its PR's gate result, or the offline checks if it has no PR yet.
  token ID            The spec approval line for the task as it is in this checkout.
  sync ID             Check that the task's PR has a valid spec approval and record it for the edit hook.
  classify [--base B] Risk signals of this checkout's diff against the base branch.
  validate [ID...]    Offline schema and completeness checks of local task files.
  approve "<line>" [--pr N] [--key path] [--post]
        For HUMANS in signed mode: sign an approval line with your SSH key and print (or post) the comment.
  doctor [--repo R]   Is the gate really hard here? (required check and its source, admins, identities)
  rollout-ok --pr N   Exit 0 only when the PR is merged, the gate is green and no assumption blocks rollout.`;

const args = process.argv.slice(2);
const command = args[0];
const VALUE_OPTIONS = ["--pr", "--repo", "--config", "--base", "--key"];
const opt = (name) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);
const positional = () => args.slice(1).filter((arg, i, all) => !arg.startsWith("--") && !VALUE_OPTIONS.includes(all[i]) && !VALUE_OPTIONS.includes(all[i - 1]));

// ---------- GitHub API ----------

const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
let cachedToken;
function token() {
  cachedToken ??= process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    || execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  return cachedToken;
}

async function api(path, { method = "GET", body, raw = false, allow404 = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "flow-gate",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (method === "GET" && attempt < 3) continue;
      throw new Error(`GitHub API ${method} ${path}: ${error.message}`);
    }
    if (allow404 && res.status === 404) return null;
    if (res.status >= 500 && method === "GET" && attempt < 3) continue;
    if (!res.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${res.status}`);
    return raw ? res.text() : res.status === 204 ? null : res.json();
  }
}

/** All pages of a list endpoint (pick extracts the array when it is wrapped). */
async function pages(path, pick = (x) => x, max = 30) {
  const out = [];
  for (let page = 1; page <= max; page++) {
    const items = pick(await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
    out.push(...items);
    if (items.length < 100) return { items: out, truncated: false };
  }
  return { items: out, truncated: true };
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
const readAt = (repo, path, ref) => api(`repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, { raw: true, allow404: true });

function repoFromGit() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", timeout: 5_000 }).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1];
  } catch { return undefined; }
}

// ---------- gathering ----------

/**
 * Everything evaluate() needs for one PR. Config, task floors and dependencies come from the repository's protected
 * default branch (never from the PR's base, which a PR can retarget); everything else from the PR head.
 */
async function gather(repo, number, { configText } = {}) {
  const [info, pr] = await Promise.all([api(`repos/${repo}`), api(`repos/${repo}/pulls/${number}`)]);
  const head = pr.head.sha, protectedRef = info.default_branch;
  const cache = new Map();
  const read = async (path, side) => {
    const ref = side === "base" ? protectedRef : head;
    const key = `${ref}\0${path}`;
    if (!cache.has(key)) cache.set(key, await readAt(repo, path, ref));
    return cache.get(key);
  };
  const ctx = {
    repo, defaultBranch: protectedRef, read,
    pr: { number: pr.number, author: pr.user?.login ?? "", body: pr.body ?? "", headSha: head, base: pr.base.ref, merged: !!pr.merged },
    prState: async (r, n) => { const p = await api(`repos/${r}/pulls/${n}`, { allow404: true }); return p && { merged: !!p.merged, body: p.body ?? "" }; },
  };
  const text = configText ?? await read(".flow/config.json", "base");
  if (text === null) ctx.configError = `.flow/config.json does not exist on ${protectedRef}: flow is not set up there (run /flow:install and merge it)`;
  else {
    try { ctx.config = JSON.parse(text); } catch (error) { ctx.configError = `.flow/config.json on ${protectedRef} is not valid JSON (${error.message})`; }
  }
  ctx.verifySignature = sshVerifier(ctx.config?.signers);
  const [files, comments, reviews, checks, root] = await Promise.all([
    pages(`repos/${repo}/pulls/${number}/files`),
    pages(`repos/${repo}/issues/${number}/comments`),
    pages(`repos/${repo}/pulls/${number}/reviews`),
    pages(`repos/${repo}/commits/${head}/check-runs`, (x) => x.check_runs, 10),
    api(`repos/${repo}/contents?ref=${encodeURIComponent(protectedRef)}`, { allow404: true }),
  ]);
  ctx.files = files.items;
  ctx.filesTruncated = files.truncated;
  ctx.comments = comments.items;
  ctx.reviews = reviews.items;
  // Commit statuses (Jenkins, CircleCI, Buildkite…) count as checks too, by their context name.
  const statuses = (await api(`repos/${repo}/commits/${head}/status?per_page=100`).catch(() => null))?.statuses ?? [];
  ctx.checks = [
    ...checks.items,
    ...statuses.map((s) => ({ name: s.context, status: s.state === "pending" ? "in_progress" : "completed", conclusion: s.state === "pending" ? null : s.state === "success" ? "success" : "failure", started_at: s.updated_at })),
  ].sort((a, b) => String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")));
  ctx.baseRoot = Array.isArray(root) ? root.map((entry) => entry.name) : null;
  ctx.deployments = [];
  if (pr.merged && pr.merge_commit_sha) {
    for (const d of await api(`repos/${repo}/deployments?sha=${pr.merge_commit_sha}&per_page=20`).catch(() => [])) {
      const [latest] = await api(`repos/${repo}/deployments/${d.id}/statuses?per_page=1`).catch(() => []);
      ctx.deployments.push({ environment: d.environment, state: latest?.state ?? "unknown" });
    }
  }
  return { ctx, pr };
}

// ---------- local files ----------

const root = () => {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000 }).trim(); } catch { return process.cwd(); }
};
const readLocal = (path) => { const full = join(root(), path); return existsSync(full) ? readFileSync(full, "utf8") : null; };
function localConfig() {
  const text = readLocal(".flow/config.json");
  if (text === null) throw new Error(".flow/config.json is missing in this checkout (run /flow:install)");
  return JSON.parse(text);
}
function localTask(id) {
  const text = readLocal(`.flow/tasks/${id}/task.json`);
  if (text === null) throw new Error(`.flow/tasks/${id}/task.json does not exist`);
  const task = JSON.parse(text);
  const docs = Object.fromEntries(specDocPaths(task).map((path) => [path, readLocal(path)]));
  return { task, docs, hash: specHash(task, docs) };
}
const localTaskIds = () => {
  const dir = join(root(), ".flow/tasks");
  return existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, "task.json"))).sort() : [];
};

// ---------- commands ----------

async function check() {
  const post = flag("post");
  const configFile = opt("config");
  if (post && configFile) throw new Error("--config is for local dry runs; the posted gate always reads the protected branch's config");
  const repo = opt("repo") || process.env.GITHUB_REPOSITORY || repoFromGit();
  let number = opt("pr") ? Number(opt("pr")) : undefined;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  if (eventName === "merge_group") {
    // Each queued PR already passed the gate with protected-branch code; combined-system tests belong to the repo's merge_group CI.
    if (post) await postCheck(repo, event.merge_group.head_sha, { ok: true, title: "flow: validated on the PR", summary: "Merge queue entry: every PR in it passed the flow gate before it was queued." });
    return 0;
  }
  // workflow_run: a CI workflow finished, so its checks can now count as evidence (fork PRs carry no PR list here).
  if (!number) number = event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : undefined) ?? event.workflow_run?.pull_requests?.[0]?.number;
  if (!number && eventName === "workflow_run") { console.log("workflow_run without a same-repo PR: nothing to judge"); return 0; }
  if (!repo || !number) throw new Error("no PR to check: pass --pr N (and --repo owner/name outside a GitHub checkout)");

  let result, headSha;
  try {
    const { ctx } = await gather(repo, number, { configText: configFile ? readFileSync(configFile, "utf8") : undefined });
    headSha = ctx.pr.headSha;
    result = await evaluate(ctx);
  } catch (error) {
    // Fail closed: an error is a failing gate, never a skipped one.
    result = { ok: false, error: `the gate could not run: ${error.message}`, tier: null, signals: [], tasks: [], blockers: [], unknowns: [], paste: [], stages: {} };
  }
  const summary = render(result, { pr: number });
  if (post) {
    const current = (await api(`repos/${repo}/pulls/${number}`)).head.sha;
    if (headSha && current !== headSha) {
      // A push landed while we were reading: its own run judges the new head. Never post a verdict about other code.
      console.log(`head moved from ${headSha.slice(0, 8)} to ${current.slice(0, 8)} during the check; leaving it to the newer run`);
      return 0;
    }
    headSha ??= current;
    const verdict = checkToPost(result);
    if (verdict) {
      await postCheck(repo, headSha, { ...verdict, summary });
      await upsertDashboard(repo, number, summary);
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  console.log(summary);
  return post ? 0 : result.ok ? 0 : 1;
}

async function postCheck(repo, sha, { ok, title, summary }) {
  const clipped = summary.length > 60_000 ? `${summary.slice(0, 60_000)}\n\n… (truncated)` : summary;
  await api(`repos/${repo}/check-runs`, {
    method: "POST",
    body: { name: "flow", head_sha: sha, status: "completed", conclusion: ok ? "success" : "failure", output: { title, summary: clipped } },
  });
}

const MARKER = "<!-- flow:dashboard -->";
async function upsertDashboard(repo, number, summary) {
  const body = `${MARKER}\n${summary}\n\n<sub>flow ${FLOW_VERSION} · updates on every push, when CI finishes, and on every comment that mentions /flow</sub>`;
  // Listed fresh (an errored gather has no comments); the newest marked bot comment is ours. If another bot owns it, post our own.
  const comments = (await pages(`repos/${repo}/issues/${number}/comments`)).items;
  const mine = comments.filter((comment) => comment.user?.type === "Bot" && (comment.body ?? "").startsWith(MARKER)).at(-1);
  if (mine?.body === body) return;
  if (mine) {
    try { await api(`repos/${repo}/issues/comments/${mine.id}`, { method: "PATCH", body: { body } }); return; } catch { /* not ours to edit */ }
  }
  await api(`repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body } });
}

async function status() {
  const config = localConfig();
  const ids = positional().length ? positional() : localTaskIds();
  if (!ids.length) { console.log("No tasks in .flow/tasks. Small changes need none; start medium or high work with /flow:start."); return 0; }
  const repo = opt("repo") || repoFromGit();
  let failed = false;
  for (const id of ids) {
    const { task, hash } = localTask(id);
    if (task.pr && repo) {
      const { ctx } = await gather(repo, task.pr);
      const result = await evaluate(ctx);
      console.log(render(result, { pr: task.pr }), "\n");
      failed ||= !result.ok;
      continue;
    }
    const errors = taskErrors(task, id, config);
    console.log(`### ${id} · ${task.title ?? ""} · ${task.tier ?? "?"} · no PR yet`);
    console.log(errors.length ? errors.map((e) => `- ${e}`).join("\n") : "- task.json is well formed (the gate checks evidence and approvals once the PR exists)");
    if (task.tier === "high") console.log(`- spec approval line: \`${approveLine(id, "spec", hash)}\``);
    console.log("");
    failed ||= errors.length > 0;
  }
  return failed ? 1 : 0;
}

function tokenCmd() {
  const [id] = positional();
  if (!id) throw new Error("usage: token ID");
  console.log(approveLine(id, "spec", localTask(id).hash));
  return 0;
}

async function sync() {
  const [id] = positional();
  if (!id) throw new Error("usage: sync ID");
  const { task, hash } = localTask(id);
  const repo = opt("repo") || repoFromGit();
  if (!task.pr || !repo) throw new Error(`task ${id} has no "pr" yet: open a draft PR with the spec, set "pr" in task.json, and ask an approver`);
  const [info, pr] = await Promise.all([api(`repos/${repo}`), api(`repos/${repo}/pulls/${task.pr}`)]);
  const text = await readAt(repo, ".flow/config.json", info.default_branch);
  if (text === null) throw new Error(`.flow/config.json is not on ${info.default_branch} yet`);
  const config = JSON.parse(text);
  const comments = (await pages(`repos/${repo}/issues/${task.pr}/comments`)).items;
  const approvals = await parseApprovals(comments, config, { prAuthor: pr.user?.login ?? "", repo, verifySignature: sshVerifier(config.signers) });
  const found = approvals.find((a) => a.ok && a.task === id && a.kind === "spec" && a.hash === hash);
  if (!found) {
    console.log(`No valid approval of the current spec on PR #${task.pr}. An approver posts:\n  ${approveLine(id, "spec", hash)}`);
    return 1;
  }
  writeFileSync(join(root(), `.flow/tasks/${id}/.approved`), `spec@${hash} by ${found.by} on PR #${task.pr}\n`);
  console.log(`Recorded: spec@${hash} approved by ${found.by}. Code edits for ${id} are unblocked in this checkout.`);
  return 0;
}

function classify() {
  const config = localConfig();
  const base = opt("base") || "main";
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", timeout: 30_000, cwd: root(), maxBuffer: 256 * 1024 * 1024 });
  const mergeBase = git("merge-base", "HEAD", `origin/${base}`).trim();
  const files = parseUnifiedDiff(git("diff", "--unified=0", "--find-renames", mergeBase));
  for (const name of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean)) {
    const text = readLocal(name) ?? "";
    files.push({ filename: name, status: "added", patch: text.split("\n").map((l) => `+${l}`).join("\n"), additions: text.split("\n").length });
  }
  const baseRoot = git("ls-tree", "--name-only", `origin/${base}`).split("\n").filter(Boolean);
  const signals = detectSignals(files, config, baseRoot);
  if (!signals.length) console.log("small: no risk rules match this diff");
  for (const s of signals) console.log(`${s.tier.padEnd(6)} ${s.id}: ${s.why}${s.files.length ? ` (${s.files.slice(0, 4).join(", ")}${s.files.length > 4 ? ", …" : ""})` : ""}`);
  return 0;
}

function validate() {
  const config = localConfig();
  const problems = configErrors(config).map((e) => `config: ${e}`);
  for (const id of positional().length ? positional() : localTaskIds()) {
    let task;
    try { task = JSON.parse(readLocal(`.flow/tasks/${id}/task.json`) ?? "null"); } catch (error) { problems.push(`${id}: invalid JSON (${error.message})`); continue; }
    problems.push(...taskErrors(task, id, config).map((e) => `${id}: ${e}`));
  }
  console.log(problems.length ? problems.map((p) => `- ${p}`).join("\n") : "ok: config and task files are well formed (the gate checks evidence and approvals on the PR)");
  return problems.length ? 1 : 0;
}

/** Humans only (the plugin's hooks refuse it for agents): sign an approval line with an SSH key. */
async function approve() {
  const [line] = positional();
  const match = /^\/flow approve ([A-Z][A-Z0-9]*-\d+) (spec|ship|override)@([0-9a-f]{24})$/.exec((line ?? "").trim());
  if (!match) throw new Error('usage: approve "/flow approve ID kind@hash" [--pr N] [--key ~/.ssh/id_ed25519] [--post]  (copy the line from the PR\'s flow comment)');
  const repo = opt("repo") || repoFromGit();
  if (!repo) throw new Error("pass --repo owner/name");
  const key = opt("key") || join(process.env.HOME ?? "", ".ssh/id_ed25519");
  const signature = execFileSync("ssh-keygen", ["-Y", "sign", "-f", key, "-n", "flow"], { input: signedMessage(repo, match[1], match[2], match[3]), encoding: "utf8", timeout: 120_000, stdio: ["pipe", "pipe", "inherit"] });
  const body = `${line.trim()}\n\n${signature.trim()}`;
  if (flag("post")) {
    const number = Number(opt("pr"));
    if (!number) throw new Error("--post needs --pr N");
    await api(`repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body } });
    console.log(`posted the signed approval on PR #${number}`);
  } else console.log(body);
  return 0;
}

const ACTIONS_APP_ID = 15368; // the GitHub Actions app

async function doctor() {
  const repo = opt("repo") || repoFromGit();
  if (!repo) throw new Error("pass --repo owner/name");
  const info = await api(`repos/${repo}`);
  const branch = info.default_branch;
  const findings = [];
  const say = (ok, text) => findings.push(`${ok ? "✅" : "❌"} ${text}`);
  const note = (text) => findings.push(`ℹ️ ${text}`);
  const configText = await readAt(repo, ".flow/config.json", branch);
  let config = null;
  try { config = configText ? JSON.parse(configText) : null; } catch { /* reported below */ }
  say(!!config, config ? `.flow/config.json is on ${branch}` : `.flow/config.json is missing or invalid on ${branch} (install and merge flow first)`);
  if (config) {
    const errors = configErrors(config);
    say(errors.length === 0, errors.length ? `config problems: ${errors.join("; ")}` : "config is valid");
    if ((config.signers ?? []).length) say(true, `approvals must be SSH-signed by ${config.signers.map((s) => s.name).join(", ")}: they hold even if agents share a human's GitHub login (as long as agents can't use the signing key; prefer a key that needs a touch)`);
    else note(`approvals are login-based (${(config.approvers ?? []).join(", ")}): hard only if agents have their own GitHub identity, listed in config.agents`);
  }
  const rules = (await api(`repos/${repo}/rules/branches/${encodeURIComponent(branch)}`, { allow404: true }).catch(() => null)) ?? [];
  const ruleChecks = rules.filter((r) => r.type === "required_status_checks");
  const protection = await api(`repos/${repo}/branches/${encodeURIComponent(branch)}/protection`, { allow404: true }).catch(() => null);
  const required = [
    ...ruleChecks.flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => ({ context: c.context, app: c.integration_id })),
    ...(protection?.required_status_checks?.checks ?? []).map((c) => ({ context: c.context, app: c.app_id })),
  ].filter((c) => c.context === "flow");
  say(required.length > 0, required.length ? `"flow" is a required check on ${branch}` : `"flow" is not a required check on ${branch}: nothing stops a merge`);
  const expected = config?.checkAppId ?? ACTIONS_APP_ID;
  if (required.length) {
    const pinned = required.every((c) => c.app === expected);
    say(pinned, pinned ? `the required check is pinned to app ${expected}${expected === ACTIONS_APP_ID ? " (GitHub Actions)" : " (your flow App)"}` : `pin the required "flow" check's source to app ${expected}; otherwise any app can post a passing "flow"`);
  }
  if (expected === ACTIONS_APP_ID) note('standard mode: any workflow can post a check as GitHub Actions, and a same-repo PR\'s workflow can ask for checks: write whatever the default token is. Hard only if agents cannot push workflow files (a token without the "workflow" scope) and existing workflows that run PR code don\'t grant checks: write. For full hardness, use the App mode in the README.');
  const strict = ruleChecks.some((r) => r.parameters?.strict_required_status_checks_policy) || protection?.required_status_checks?.strict;
  if (required.length) say(!!strict, strict ? "branches must be up to date before merging (verdicts can't go stale against a moved base)" : "require branches to be up to date before merging, or a verdict can go stale when the base moves");
  if (protection) say(!!protection.enforce_admins?.enabled, protection.enforce_admins?.enabled ? "admins can't bypass branch protection" : "admins can bypass branch protection: an admin token merges past the gate");
  if (ruleChecks.length) note("rulesets apply: make sure no agent identity is in a ruleset's bypass list (this token can't read bypass lists)");
  const permissions = await api(`repos/${repo}/actions/permissions/workflow`).catch(() => null);
  if (permissions) say(permissions.default_workflow_permissions === "read", `default workflow token: ${permissions.default_workflow_permissions}${permissions.default_workflow_permissions === "read" ? "" : " (set it to read-only, so existing workflows that run PR code can't post checks unless they ask)"}`);
  let me = null;
  try { me = (await api("user")).login; } catch { /* an App token has no user */ }
  if (me && config && !(config.signers ?? []).length) {
    const lowerMe = me.toLowerCase();
    if ((config.agents ?? []).some((a) => a.toLowerCase() === lowerMe)) say(true, `logged in as ${me}, listed in config.agents: its approvals never count`);
    else if ((config.approvers ?? []).some((a) => a.split("#")[0].toLowerCase() === lowerMe)) say(false, `logged in as ${me}, an approver: if agents use this login they can approve as you. Give agents their own identity or switch to signed approvals`);
    else note(`logged in as ${me} (neither approver nor agent)`);
  }
  if (!(await readAt(repo, ".github/workflows/flow.yml", branch))) say(false, `no .github/workflows/flow.yml on ${branch}`);
  console.log(`flow doctor · ${repo} · ${branch}\n${findings.join("\n")}`);
  return findings.some((f) => f.startsWith("❌")) ? 1 : 0;
}

async function rolloutOk() {
  const repo = opt("repo") || process.env.GITHUB_REPOSITORY || repoFromGit();
  const number = Number(opt("pr"));
  if (!repo || !number) throw new Error("usage: rollout-ok --pr N [--repo owner/name]");
  const { ctx } = await gather(repo, number);
  const result = await evaluate(ctx);
  const reasons = [];
  if (!ctx.pr.merged) reasons.push("the PR is not merged");
  if (result.skipped) reasons.push(result.skipped);
  if (!result.ok) reasons.push(...result.blockers);
  reasons.push(...(result.rolloutBlockers ?? []).map((a) => `unverified assumption blocks rollout: ${a}`));
  console.log(reasons.length ? `rollout blocked:\n- ${reasons.join("\n- ")}` : `rollout ok: PR #${number} merged, gate green, nothing blocks rollout`);
  return reasons.length ? 1 : 0;
}

const COMMANDS = { check, status, token: tokenCmd, sync, classify, validate, approve, doctor, "rollout-ok": rolloutOk };
const run = COMMANDS[command];
if (!run) { console.log(USAGE); process.exit(command ? 2 : 0); }
Promise.resolve().then(run).then((code) => process.exit(code ?? 0), (error) => { console.error(`flow ${command}: ${error.message}`); process.exit(1); });
