// flow gate library: one evaluator for the CI gate, `flow status`, local dry runs and the plugin hooks.
// Logic only: flow.mjs does the GitHub I/O; sshVerifier is the one helper that runs a process. /flow:install copies this file into repos as .github/flow/lib.mjs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FLOW_VERSION = "2.0.0";
export const SCHEMA = 1;
export const TIERS = ["small", "medium", "high"];
const KINDS = ["functional", "safety", "operational"];
const SEVERITIES = ["critical", "normal"];
const VERIFY = ["unit", "integration", "e2e", "failure_injection", "eval", "canary", "manual"];
const SAFETY_VERIFY = ["integration", "e2e", "failure_injection", "eval"]; // a critical safety invariant is never proven by unit or manual
export const WAIVABLE = ["challenge", "capacity", "measured-workload", "verify"]; // never: criteria, evidence of critical behavior, approvals
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+$/;
const TASK_KEYS = ["schema", "id", "title", "tier", "signals", "outcome", "criteria", "decisions", "challenge", "capacity", "integration", "waivers", "branch", "pr", "evidence", "evals", "log"];
// Progress fields change while building and are checked as evidence; everything else is the approved spec.
export const PROGRESS_KEYS = ["branch", "pr", "evidence", "evals", "log"];
const HASH_LEN = 24; // 96 bits: an approval can't be ground to fit a different spec
// The gate's own runs never count as CI evidence or as "tested".
export const GATE_CHECKS = ["flow", "flow-gate"];

// Rules the config can't remove: the gate protects itself, and what can't be scanned is never small.
export const BUILTIN_RULES = [
  { id: "flow-gate", tier: "high", why: "changes the flow gate or its config", paths: [".github/flow/**", ".github/workflows/flow.yml", ".flow/config.json"] },
  { id: "unscanned", tier: "high", why: "part of the diff is binary or too large to scan for risk patterns" },
  { id: "new-module", tier: "medium", why: "adds a new top-level directory" },
];

export const tierRank = (tier) => Math.max(0, TIERS.indexOf(tier));
export const maxTier = (tiers) => TIERS[Math.max(0, ...tiers.map(tierRank))];
const str = (value) => typeof value === "string" && value.trim().length > 0;
const PLACEHOLDER = /^(n\/?a|none|tbd|todo|\?+|-+|\.+|<.*>)$/i;
/** Free text that says something: not empty, not a placeholder, not one word. */
const substantive = (value) => str(value) && !PLACEHOLDER.test(value.trim()) && value.trim().length >= 12;
const lower = (value) => String(value ?? "").toLowerCase();
/** Text from task files shown in Markdown: no links, mentions, HTML or table breaks. */
const esc = (value) => String(value ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_[\]|#]/g, "\\$&").replace(/@/g, "@\u200b").replace(/\n/g, " ");

// ---------- globs and hashing ----------

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (path, globs = []) => globs.some((glob) => globToRegExp(glob).test(path));

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value ?? null);
const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, HASH_LEN);

/** Files whose content is part of the approved spec, besides task.json itself. */
export function specDocPaths(task) {
  const dir = `.flow/tasks/${task.id}`;
  const paths = [`${dir}/design.md`];
  if (task.challenge && str(task.challenge.review) && !/[/\\]|\.\./.test(task.challenge.review)) paths.push(`${dir}/${task.challenge.review}`);
  return paths;
}

/** Hash of the approved scope: task.json minus progress fields, plus the design and challenge review text. */
export function specHash(task, docs = {}) {
  const spec = Object.fromEntries(Object.entries(task).filter(([key]) => !PROGRESS_KEYS.includes(key)));
  const text = specDocPaths(task).map((path) => `--- ${path}\n${(docs[path] ?? "").replace(/\r\n?/g, "\n")}`).join("\n");
  return sha(`${canonical(spec)}\n${text}`);
}

/** Hash of the PR's changes against its merge base: survives a clean "Update branch", changes with any edit. */
export const diffHash = (files) => sha([...files].sort((a, b) => a.filename.localeCompare(b.filename))
  .map((f) => `${f.filename}\0${f.previous_filename ?? ""}\0${f.status}\0${typeof f.patch === "string" ? f.patch : `blob:${f.sha ?? ""}`}`).join("\n"));

export const approveLine = (id, kind, hash) => `/flow approve ${id} ${kind}@${hash}`;
/** What a signer signs (ssh-keygen -Y sign -n flow): the repo is included so a signature can't be replayed elsewhere. */
export const signedMessage = (repo, id, kind, hash) => `flow approve ${lower(repo)} ${id} ${kind}@${hash}\n`;

// ---------- config ----------

export function configErrors(config) {
  const errors = [];
  if (!config || typeof config !== "object") return ["config is not a JSON object"];
  if (config.schema !== SCHEMA) errors.push(`config schema must be ${SCHEMA} (got ${JSON.stringify(config.schema)}); upgrade the gate with /flow:install`);
  for (const key of ["approvers", "agents", "ignore", "codeFiles", "branches", "reviewBots", "approvalBeforeBuild"]) {
    if (config[key] !== undefined && !(Array.isArray(config[key]) && config[key].every(str))) errors.push(`config.${key} must be a list of strings`);
  }
  const signers = config.signers ?? [];
  if (!Array.isArray(signers) || signers.some((s) => !/^[\w.-]+$/.test(s?.name ?? "") || !/^(ssh-ed25519|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com|ssh-rsa) \S+/.test(s?.key ?? ""))) {
    errors.push("config.signers must be [{ name, key: \"ssh-ed25519 AAAA…\" }]");
  }
  if (!(Array.isArray(config.approvers) && config.approvers.length) && !(Array.isArray(signers) && signers.length)) errors.push("config has no approvers and no signers: nobody could approve anything");
  if (config.distinctApprover !== undefined && typeof config.distinctApprover !== "boolean") errors.push("config.distinctApprover must be true or false");
  for (const key of ["minScorerAccuracy"]) if (config[key] !== undefined && !(config[key] > 0 && config[key] <= 1)) errors.push(`config.${key} must be in (0, 1]`);
  for (const key of ["minGold", "minEvalRuns", "checkAppId"]) if (config[key] !== undefined && !(Number.isInteger(config[key]) && config[key] >= 1)) errors.push(`config.${key} must be a positive integer`);
  if (config.verify !== undefined && (typeof config.verify !== "object" || Object.entries(config.verify).some(([kind, v]) => !VERIFY.includes(kind) || typeof v !== "object"))) {
    errors.push(`config.verify maps a verify kind (${VERIFY.join(", ")}) to { paths, checks }`);
  }
  const ids = new Set(BUILTIN_RULES.map((rule) => rule.id));
  if (config.risk !== undefined && !Array.isArray(config.risk)) errors.push("config.risk must be a list");
  for (const [index, rule] of (Array.isArray(config.risk) ? config.risk : []).entries()) {
    const at = `config.risk[${index}]`;
    if (!/^[a-z0-9-]+$/.test(rule?.id ?? "")) { errors.push(`${at}.id must be lowercase letters, digits and dashes`); continue; }
    if (ids.has(rule.id)) errors.push(`${at}: duplicate rule id "${rule.id}"`);
    ids.add(rule.id);
    if (!["medium", "high"].includes(rule.tier)) errors.push(`${at} (${rule.id}): tier must be medium or high`);
    if (!str(rule.why)) errors.push(`${at} (${rule.id}): why is required`);
    if (!rule.paths && !rule.lines && !rule.minAdded) errors.push(`${at} (${rule.id}): needs paths, lines or minAdded`);
    for (const pattern of rule.lines ?? []) {
      try { new RegExp(pattern); } catch { errors.push(`${at} (${rule.id}): bad regex ${JSON.stringify(pattern)}`); }
    }
  }
  return errors;
}

export const allRules = (config) => [...BUILTIN_RULES, ...(config.risk ?? [])];

// ---------- diffs and risk detection ----------

/** Turn `git diff` output into the GitHub files shape detectSignals expects. */
export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  for (const line of text.split("\n")) {
    const start = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (start) { file = { filename: start[2], status: "modified", patch: "", additions: 0 }; files.push(file); continue; }
    if (!file) continue;
    if (line.startsWith("rename from ")) { file.previous_filename = line.slice(12); file.status = "renamed"; }
    else if (line.startsWith("deleted file")) file.status = "removed";
    else if (line.startsWith("new file")) file.status = "added";
    else if (line.startsWith("Binary files")) delete file.patch;
    else if (/^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line) && typeof file.patch === "string") {
      file.patch += `${line}\n`;
      if (line.startsWith("+")) file.additions++;
    }
  }
  return files;
}

/** Lines a patch adds or removes (removing a guard is as risky as adding a worker). */
export const changedLines = (patch) => patch.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)).map((line) => line.slice(1));

/** Signals one file trips: path rules on both names of a rename, line rules on changed lines. Shared by the gate and the edit hook. */
export function fileSignals(file, config, rules = allRules(config)) {
  const names = [file.filename, file.previous_filename].filter(Boolean);
  const ignored = names.every((name) => matchesAny(name, config.ignore));
  const out = [];
  for (const rule of rules) {
    const builtin = BUILTIN_RULES.includes(rule);
    if (ignored && !builtin) continue;
    if (rule.paths && names.some((name) => matchesAny(name, rule.paths))) { out.push(rule); continue; }
    if (!rule.lines || typeof file.patch !== "string") continue;
    const scope = rule.in ?? config.codeFiles;
    if (scope && !names.some((name) => matchesAny(name, scope))) continue;
    const patterns = rule.lines.map((pattern) => new RegExp(pattern, "i"));
    if (changedLines(file.patch).some((line) => patterns.some((pattern) => pattern.test(line)))) out.push(rule);
  }
  if (!ignored && typeof file.patch !== "string" && file.status !== "removed") out.push(BUILTIN_RULES[1]);
  return out;
}

/**
 * Risk signals of a diff. files: [{ filename, previous_filename?, status, patch?, additions }] as the GitHub API returns them.
 * baseRoot: the top-level names on the base branch (to spot a new top-level directory), or null to skip that rule.
 */
export function detectSignals(files, config, baseRoot = null) {
  const rules = allRules(config);
  const hits = new Map();
  const hit = (rule, file) => {
    if (!hits.has(rule.id)) hits.set(rule.id, { id: rule.id, tier: rule.tier, why: rule.why, capacity: !!rule.capacity, files: [] });
    const entry = hits.get(rule.id);
    if (file && !entry.files.includes(file)) entry.files.push(file);
  };
  let added = 0;
  for (const file of files) {
    for (const rule of fileSignals(file, config, rules)) hit(rule, file.filename);
    if ([file.filename, file.previous_filename].filter(Boolean).every((name) => matchesAny(name, config.ignore))) continue;
    added += file.additions ?? 0;
    const top = file.filename.includes("/") ? file.filename.split("/")[0] : null;
    if (baseRoot && file.status === "added" && top && !baseRoot.includes(top)) hit(BUILTIN_RULES[2], file.filename);
  }
  for (const rule of rules) if (rule.minAdded && added >= rule.minAdded) hit(rule, null);
  return [...hits.values()];
}

// ---------- task validation ----------

export function taskErrors(task, dirId, config) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return ["task.json is not a JSON object"];
  const errors = [];
  const known = new Set(allRules(config).map((rule) => rule.id));
  if (task.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA} (got ${JSON.stringify(task.schema)})`);
  if (task.id !== dirId || !TASK_ID.test(task.id ?? "")) errors.push(`id must be "${dirId}" (the directory name, like ABC-12)`);
  for (const key of Object.keys(task)) if (!TASK_KEYS.includes(key)) errors.push(`unknown field "${key}"`);
  if (!str(task.title)) errors.push("title is required");
  if (!TIERS.includes(task.tier)) errors.push(`tier must be one of ${TIERS.join(", ")}`);
  if (!Array.isArray(task.signals ?? [])) errors.push("signals must be a list of risk rule ids");
  else for (const signal of task.signals ?? []) if (!known.has(signal)) errors.push(`signals: unknown risk rule "${signal}"`);
  const seen = new Set();
  if (task.criteria !== undefined && !Array.isArray(task.criteria)) errors.push("criteria must be a list");
  for (const [index, c] of (Array.isArray(task.criteria) ? task.criteria : []).entries()) {
    const at = `criteria[${index}]${c?.id ? ` (${c.id})` : ""}`;
    if (!str(c?.id) || !c.id.startsWith(`${task.id}.`)) errors.push(`${at}: id must start with "${task.id}."`);
    else if (seen.has(c.id)) errors.push(`${at}: duplicate id`);
    seen.add(c?.id);
    if (!KINDS.includes(c?.kind)) errors.push(`${at}: kind must be ${KINDS.join(", ")}`);
    if (!SEVERITIES.includes(c?.severity)) errors.push(`${at}: severity must be ${SEVERITIES.join(" or ")}`);
    if (!VERIFY.includes(c?.verify)) errors.push(`${at}: verify must be ${VERIFY.join(", ")}`);
    if (!substantive(c?.behavior)) errors.push(`${at}: behavior must say what holds, testably`);
    if (c?.kind === "safety" && c?.severity === "critical" && VERIFY.includes(c?.verify) && !SAFETY_VERIFY.includes(c.verify)) {
      errors.push(`${at}: a critical safety invariant needs ${SAFETY_VERIFY.join(", ")} verification, not ${c.verify}`);
    }
  }
  if (task.decisions !== undefined && !Array.isArray(task.decisions)) errors.push("decisions must be a list");
  for (const [index, d] of (Array.isArray(task.decisions) ? task.decisions : []).entries()) {
    if (!str(d?.id) || !substantive(d?.question)) errors.push(`decisions[${index}]: id and question are required`);
  }
  if (task.waivers !== undefined && (!Array.isArray(task.waivers) || task.waivers.some((w) => !WAIVABLE.includes(w?.item) || !substantive(w?.why)))) {
    errors.push(`waivers must be [{ item, why }] with item one of ${WAIVABLE.join(", ")}`);
  }
  if (task.integration !== undefined && (typeof task.integration !== "object" || !Array.isArray(task.integration.dependsOn ?? []))) {
    errors.push("integration must be an object with a dependsOn list");
  }
  if (task.evidence !== undefined && (typeof task.evidence !== "object" || Array.isArray(task.evidence) || Object.values(task.evidence).some((refs) => !Array.isArray(refs)))) {
    errors.push("evidence must map each criterion id to a list of refs");
  }
  if (task.challenge?.review !== undefined && (!str(task.challenge.review) || /[/\\]|\.\./.test(task.challenge.review))) {
    errors.push("challenge.review must be a file name inside the task directory");
  }
  if (task.pr !== undefined && !Number.isInteger(task.pr)) errors.push("pr must be a PR number");
  return errors;
}

function challengeErrors(ch, tier) {
  if (!ch || typeof ch !== "object") return [`challenge is required for ${tier} risk (/flow:challenge)`];
  const errors = [];
  if (!substantive(ch.simplest)) errors.push("challenge.simplest: what is the simplest thing that meets the outcome?");
  const modes = Array.isArray(ch.failureModes) ? ch.failureModes.filter(substantive).length : 0;
  if (tier === "medium") {
    if (modes < 2) errors.push("challenge.failureModes: the 2 most likely ways this fails");
    return errors;
  }
  for (const key of ["existingMayBeWrong", "scale", "e2eProof"]) if (!substantive(ch[key])) errors.push(`challenge.${key} needs a real answer`);
  if (modes < 3) errors.push("challenge.failureModes: the 3 most likely ways this fails");
  const alternatives = Array.isArray(ch.alternatives) ? ch.alternatives : [];
  if (alternatives.filter((a) => str(a?.name) && substantive(a?.why)).length < 2) errors.push("challenge.alternatives needs at least 2 options, each with why");
  if (alternatives.filter((a) => a?.chosen === true).length !== 1) errors.push("challenge.alternatives must mark exactly one option chosen");
  const assumptions = Array.isArray(ch.assumptions) ? ch.assumptions : [];
  if (assumptions.length === 0) errors.push("challenge.assumptions must list what could invalidate the plan");
  for (const [index, a] of assumptions.entries()) {
    if (!substantive(a?.text)) errors.push(`challenge.assumptions[${index}]: text is required`);
    if (!["verified", "unverified"].includes(a?.status)) errors.push(`challenge.assumptions[${index}]: status must be verified or unverified`);
    else if (a.status === "verified" && !substantive(a?.evidence)) errors.push(`challenge.assumptions[${index}]: a verified assumption names its evidence`);
    else if (a.status === "unverified" && !["merge", "rollout", "none"].includes(a?.blocks)) errors.push(`challenge.assumptions[${index}]: an unverified assumption says what it blocks (merge, rollout or none)`);
  }
  if (!str(ch.review)) errors.push("challenge.review must name the independent reviewer's notes file");
  return errors;
}

const CAPACITY_KEYS = { workload: ["users", "workPerUser"], latency: ["firstResult"], cost: ["perUser"] };

function capacityErrors(capacity, tier, waived) {
  if (!capacity || typeof capacity !== "object") return ["capacity is required: this change adds work that scales (queue, worker, model call, external API, bulk job)"];
  const errors = [];
  for (const [group, required] of Object.entries(CAPACITY_KEYS)) {
    const metrics = capacity[group];
    if (!metrics || typeof metrics !== "object") { errors.push(`capacity.${group} is required (${required.join(", ")})`); continue; }
    for (const key of required) if (!metrics[key]) errors.push(`capacity.${group}.${key} is required`);
    for (const [name, m] of Object.entries(metrics)) {
      const at = `capacity.${group}.${name}`;
      if (typeof m?.value !== "number" && !str(m?.value)) errors.push(`${at}: value is required`);
      if (m?.source === "measured") {
        if (!substantive(m?.ref) || !/^\d{4}-\d{2}-\d{2}/.test(m?.at ?? "")) errors.push(`${at}: a measured number names where (ref) and when (at, YYYY-MM-DD) it was measured`);
      } else if (m?.source === "estimate") {
        if (!substantive(m?.basis)) errors.push(`${at}: an estimate states its basis`);
      } else errors.push(`${at}: source must be measured or estimate`);
    }
  }
  if (!substantive(capacity.cut80)) errors.push("capacity.cut80: answer \"could we drop 80% of this processing and keep most of the value?\"");
  if (tier === "high" && !waived && !Object.values(capacity.workload ?? {}).some((m) => m?.source === "measured")) {
    errors.push("capacity.workload has no measured production number: high risk needs at least one (a human can export it if you lack access)");
  }
  return errors;
}

// ---------- comments ----------

const APPROVE_FIRST_LINE = /^\/flow[ \t]+approve[ \t]+([A-Z][A-Z0-9]*-\d+)[ \t]+(spec|ship|override)@([0-9a-f]{24})[ \t]*$/;
const SIGNATURE = /-----BEGIN SSH SIGNATURE-----[\s\S]+?-----END SSH SIGNATURE-----/;

/** "login" or "login#123456" (the numeric id survives a rename). */
const approverMatches = (entry, user) => {
  const [login, id] = entry.split("#");
  return lower(login) === lower(user?.login) && (!id || String(user?.id) === id);
};

/**
 * Approvals in PR comments. Only the first line of a comment counts, so quotes and prose never match.
 * Signed mode (config.signers): only an SSH signature by a listed signer counts, whoever posted it.
 * Login mode: a comment by a listed approver, never edited, not by an agent login or a bot.
 */
export async function parseApprovals(comments, config, { prAuthor, repo, verifySignature }) {
  const signed = (config.signers ?? []).length > 0;
  const approvers = config.approvers ?? [];
  const agents = (config.agents ?? []).map(lower);
  const out = [];
  for (const comment of comments) {
    const body = (comment.body ?? "").replace(/\r\n?/g, "\n").trim();
    const match = APPROVE_FIRST_LINE.exec(body.split("\n")[0]);
    if (!match) continue;
    const [, task, kind, hash] = match;
    const login = comment.user?.login ?? "";
    let by = null, why = null;
    if (signed) {
      const signature = SIGNATURE.exec(body)?.[0];
      by = signature && verifySignature ? await verifySignature(signedMessage(repo, task, kind, hash), signature) : null;
      if (!by) why = signature ? "its signature does not verify against config.signers" : "it is not signed (this repo requires signed approvals)";
    } else if (comment.user?.type === "Bot" || login.endsWith("[bot]")) why = "posted by a bot";
    else if (agents.includes(lower(login))) why = "posted by an agent login";
    else if (!approvers.some((entry) => approverMatches(entry, comment.user))) why = "posted by someone not in config.approvers";
    else if (config.distinctApprover !== false && lower(login) === lower(prAuthor)) why = "posted by the PR author (config.distinctApprover)";
    else if (comment.updated_at && comment.created_at && Date.parse(comment.updated_at) - Date.parse(comment.created_at) > 5_000) why = "edited after posting (post a new comment)";
    else by = login;
    out.push({ task, kind, hash, login, by, ok: !!by, why });
  }
  return out;
}

export const taskIdsFromBody = (body) => [...(body ?? "").matchAll(/^[ \t]*Flow-Task:[ \t]*(.+)$/gim)]
  .flatMap((m) => m[1].split(/[\s,]+/)).filter((id) => TASK_ID.test(id));

const section = (body, title) => {
  const match = (body ?? "").replace(/\r\n?/g, "\n").match(new RegExp(`^##\\s*${title}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|(?![\\s\\S]))`, "im"));
  return match ? match[1].replace(/<!--[\s\S]*?-->/g, "").trim() : null;
};

// ---------- evidence ----------

const SKIPPED = /\.(skip|todo|only)\b|\bx(it|test|describe)\s*\(|\btest\.todo\b|@(Disabled|Ignore)\b|pytest\.mark\.skip/;
const COMMENT = /^\s*(\/\/|#|\*|\/\*|--)/;
const latestCheck = (ctx, name) => ctx.checks.filter((check) => check.name === name && !GATE_CHECKS.includes(check.name)).at(-1);

/** Resolve one evidence ref against the PR head. Returns null when it holds, else the reason it doesn't. */
async function refProblem(ref, criterion, ctx, evalsProblem) {
  const match = /^(test|ci|eval|url):(.+)$/.exec(ref ?? "");
  if (!match) return `"${ref}" is not test:<path>#<test name>, ci:<check>, eval:<suite> or url:<link>`;
  const [, kind, rest] = match;
  const verify = criterion.verify;
  const rule = ctx.config.verify?.[verify];
  const checksPass = (names) => names.some((name) => latestCheck(ctx, name)?.conclusion === "success");
  if (kind === "test") {
    const [rawPath, rawName] = rest.split("#");
    const path = rawPath.trim(), name = rawName?.trim();
    if (!name) return `${path}: name the test (test:<path>#<test name>)`;
    if (rule?.paths && !matchesAny(path, rule.paths)) return `${path} is not where ${verify} tests live (config.verify.${verify}.paths: ${rule.paths.join(", ")})`;
    const text = await ctx.read(path, "head");
    if (text === null) return `test file ${path} does not exist in this PR`;
    const lines = text.split("\n").filter((line) => line.includes(name));
    if (lines.length === 0) return `${path} has no test named "${name}"`;
    if (!lines.some((line) => !SKIPPED.test(line) && !COMMENT.test(line))) return `"${name}" in ${path} is skipped, a todo or a comment`;
    if (rule?.checks?.length && !checksPass(rule.checks)) return `the ${verify} suite (${rule.checks.join(" or ")}) has not passed on this commit`;
    return null;
  }
  if (kind === "ci") {
    const name = rest.trim();
    if (rule?.checks?.length && !rule.checks.includes(name)) return `"${name}" is not a ${verify} check (config.verify.${verify}.checks: ${rule.checks.join(", ")})`;
    const run = latestCheck(ctx, name);
    if (!run) return `no CI check named "${name}" ran on this commit`;
    return run.conclusion === "success" ? null : `CI check "${name}" is ${run.conclusion ?? run.status}`;
  }
  if (kind === "eval") return verify === "eval" ? evalsProblem : "eval: evidence only counts for criteria verified by eval";
  return verify === "manual" ? null : "url: evidence only counts for manual criteria (others need a test, CI check or eval)";
}

/** null when the eval can count as evidence, else why not. */
async function evalsProblemFor(task, ctx, critical) {
  const config = ctx.config;
  const gold = task.evals?.gold;
  if (!gold) return "no gold set (known-good and known-bad cases the scorer must classify correctly)";
  const total = (gold.good ?? 0) + (gold.bad ?? 0);
  const minGold = config.minGold ?? 10;
  if (!(gold.good >= 1 && gold.bad >= 1) || total < minGold) return `the gold set needs known-good and known-bad cases, at least ${minGold} in all`;
  if (!str(gold.ref)) return "the gold set needs a ref (a file on the base branch listing its cases)";
  const ref = gold.ref.replace(/\/+$/, "");
  if ((await ctx.read(ref, "base")) === null) return `the gold set ${ref} is not on the base branch: land it in its own PR first, so the scorer is judged on cases this PR didn't write`;
  if (ctx.files.some((f) => [f.filename, f.previous_filename].some((name) => name && (name === ref || name.startsWith(`${ref}/`))))) {
    return `this PR changes the gold set ${ref}: change it in its own PR`;
  }
  const accuracy = (gold.correct ?? 0) / total;
  const min = config.minScorerAccuracy ?? 1;
  if (!(accuracy >= min)) return `the scorer classified ${gold.correct ?? 0}/${total} gold cases correctly (needs ${Math.round(min * 100)}%)`;
  const res = task.evals?.results;
  if (!res) return "evals.results are missing";
  if (critical && !((res.runs ?? 0) >= (config.minEvalRuns ?? 3))) return `a critical eval needs at least ${config.minEvalRuns ?? 3} runs (results.runs) to separate noise from change`;
  if (res.check && latestCheck(ctx, res.check)?.conclusion !== "success") return `the eval check "${res.check}" has not passed on this commit`;
  return null;
}

// ---------- SSH signatures (the one helper here that runs a process) ----------

/** Verify an SSH signature against config.signers with ssh-keygen; returns the signer's name or null. */
export function sshVerifier(signers = []) {
  return async (message, signature) => {
    if (!signers.length) return null;
    const dir = mkdtempSync(join(tmpdir(), "flow-sig-"));
    try {
      const allowed = join(dir, "allowed"), sig = join(dir, "sig");
      writeFileSync(allowed, signers.map((s) => `${s.name} namespaces="flow" ${s.key}`).join("\n") + "\n");
      writeFileSync(sig, `${signature.trim()}\n`);
      for (const s of signers) {
        try {
          execFileSync("ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", s.name, "-n", "flow", "-s", sig], { input: message, timeout: 10_000, stdio: ["pipe", "ignore", "ignore"] });
          return s.name;
        } catch { /* not this signer */ }
      }
      return null;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

// ---------- evaluate ----------

/**
 * ctx: {
 *   repo, defaultBranch, config, configError?, pr: { number, author, body, headSha, base, merged },
 *   files, filesTruncated?, baseRoot, comments, reviews, checks, deployments,
 *   read: async (path, "head" | "base") => string | null,      // base = the protected branch the config came from
 *   prState: async (repo, number) => { merged, body } | null,  // for dependencies
 *   verifySignature: async (message, signature) => signerName | null,
 * }
 * Returns { ok, error?, skipped?, mode, tier, signals, small?, tasks, blockers, unknowns, paste, stages, rolloutBlockers, shipHash }.
 */
export async function evaluate(ctx) {
  const blockers = [], unknowns = [], paste = [];
  const empty = { tier: null, signals: [], tasks: [], unknowns: [], paste: [], stages: {}, rolloutBlockers: [] };
  if (ctx.configError) return { ...empty, ok: false, error: ctx.configError, blockers: [ctx.configError] };
  const config = ctx.config;
  const configProblems = configErrors(config);
  if (configProblems.length) {
    const error = `.flow/config.json on the protected branch is invalid: ${configProblems.join("; ")}`;
    return { ...empty, ok: false, error, blockers: [error] };
  }
  const protectedBranches = config.branches?.length ? config.branches : [ctx.defaultBranch].filter(Boolean);
  if (ctx.pr.base && protectedBranches.length && !protectedBranches.includes(ctx.pr.base)) {
    return { ...empty, ok: true, skipped: `base ${ctx.pr.base} is not a protected branch (${protectedBranches.join(", ")}); the gate judges this work when it targets one`, blockers: [] };
  }
  if (ctx.filesTruncated) {
    const error = "the PR changes more files than the GitHub API lists (3000); split it";
    return { ...empty, ok: false, error, blockers: [error] };
  }
  const mode = (config.signers ?? []).length ? "signed" : "login";
  const shipHash = diffHash(ctx.files);

  const signals = detectSignals(ctx.files, config, ctx.baseRoot);
  const detectedTier = maxTier(signals.map((s) => s.tier));
  const touched = new Set();
  for (const file of ctx.files) {
    for (const name of [file.filename, file.previous_filename].filter(Boolean)) {
      const m = /^\.flow\/tasks\/([^/]+)\//.exec(name);
      if (!m) continue;
      touched.add(m[1]);
      if (/\/task\.json$/.test(name) && file.status === "removed") blockers.push(`removes task ${m[1]}: task records are the approval trail; keep them`);
      if (/\/task\.json$/.test(name) && file.status === "renamed" && name === file.previous_filename) blockers.push(`renames task ${m[1]}: task ids are permanent`);
    }
  }
  const ids = [...new Set([...taskIdsFromBody(ctx.pr.body), ...touched])];
  const approvals = await parseApprovals(ctx.comments, config, { prAuthor: ctx.pr.author, repo: ctx.repo, verifySignature: ctx.verifySignature });
  const rules = new Map(allRules(config).map((rule) => [rule.id, rule]));
  if (mode === "login" && config.distinctApprover === false) unknowns.push("approvals are login-based and the PR author may approve: if agents share a human's GitHub login, approvals are only as good as the agent's honesty (use signed approvals)");

  // Fast path: no task, nothing risky.
  if (ids.length === 0) {
    if (detectedTier !== "small") {
      blockers.push(`detected ${detectedTier} risk (${signals.map((s) => `${s.id}: ${s.why}`).join("; ")}): add a task (.flow/tasks/<ID>/task.json) and a "Flow-Task: <ID>" line to the PR body`);
    } else if (!section(ctx.pr.body, "Evidence")) {
      blockers.push('small change: the PR body needs a non-empty "## Evidence" section (what you ran and what it showed)');
    }
    return { ok: blockers.length === 0, mode, tier: detectedTier, signals, small: detectedTier === "small", tasks: [], blockers, unknowns, paste, stages: stagesFor(ctx, []), rolloutBlockers: [], shipHash };
  }

  const listed = new Set();
  const results = [];
  for (const id of ids) {
    const r = { id, tier: null, hash: null, blockers: [], unknowns: [], rolloutBlockers: [], dims: {}, approved: { spec: false, ship: false, override: false } };
    results.push(r);
    const raw = TASK_ID.test(id) ? await ctx.read(`.flow/tasks/${id}/task.json`, "head") : null;
    if (raw === null) { r.blockers.push(`task ${id}: .flow/tasks/${id}/task.json does not exist in this PR`); continue; }
    let task;
    try { task = JSON.parse(raw); } catch (error) { r.blockers.push(`task ${id}: task.json is not valid JSON (${error.message})`); continue; }
    const structural = taskErrors(task, id, config);
    if (structural.length) { r.blockers.push(...structural.map((e) => `task ${id}: ${e}`)); continue; }
    r.task = task;
    r.title = task.title;
    for (const s of task.signals ?? []) listed.add(s);
    const add = (problem) => r.blockers.push(`task ${id}: ${problem}`);

    const docs = {};
    for (const path of specDocPaths(task)) docs[path] = await ctx.read(path, "head");
    r.hash = specHash(task, docs);
    const okApproval = (kind, hash) => approvals.some((a) => a.ok && a.task === id && a.kind === kind && a.hash === hash);
    const ask = (kind, hash, what) => {
      const line = approveLine(id, kind, hash);
      add(`${what}: an approver posts \`${line}\`${mode === "signed" ? " (signed)" : ""}`);
      paste.push(line);
      for (const a of approvals.filter((a) => a.task === id && a.kind === kind)) {
        if (!a.ok && a.hash === hash) r.unknowns.push(`ignored ${kind} approval by ${a.login}: ${a.why}`);
        else if (a.ok && a.hash !== hash) r.unknowns.push(`a ${kind} approval by ${a.by} covers an earlier version (${a.hash.slice(0, 8)}…); it changed since`);
      }
    };

    // Tier: the declared tier, but never below its signals or the tier it had on the base branch, unless an approver overrides.
    let baseTier = null;
    const baseRaw = await ctx.read(`.flow/tasks/${id}/task.json`, "base");
    if (baseRaw !== null) { try { baseTier = JSON.parse(baseRaw).tier; } catch { baseTier = "high"; } }
    const floor = maxTier([...(task.signals ?? []).map((s) => rules.get(s)?.tier ?? "small"), TIERS.includes(baseTier) ? baseTier : "small"]);
    const waived = new Set((task.waivers ?? []).map((w) => w.item));
    const lowered = tierRank(task.tier) < tierRank(floor);
    const overrideNeeded = (lowered || waived.size > 0) && task.tier !== "high";
    r.approved.spec = okApproval("spec", r.hash);
    r.approved.override = okApproval("override", r.hash);
    const overridden = overrideNeeded && r.approved.override;
    const tier = lowered && !overridden ? floor : task.tier;
    // A waiver counts only once a human approved the spec that carries it.
    const waiving = (item) => waived.has(item) && (tier === "high" ? r.approved.spec : overridden);
    r.tier = tier;
    r.lowered = lowered ? { from: floor, to: task.tier } : null;

    if (tier !== "small") {
      if (!substantive(task.outcome)) add("outcome must state the user outcome being optimized");
      if (!Array.isArray(task.criteria) || task.criteria.length === 0) add("criteria are required (functional, safety, operational; each with how it is verified)");
      if (!waiving("challenge")) for (const e of challengeErrors(task.challenge, tier)) add(e);
    }
    if (tier === "high") {
      if (!substantive(docs[`.flow/tasks/${id}/design.md`])) add("design.md is required for high risk");
      if (!(task.criteria ?? []).some((c) => c.kind === "safety")) add("high risk needs at least one safety invariant (what must never happen)");
      const reviewPath = task.challenge?.review ? `.flow/tasks/${id}/${task.challenge.review}` : null;
      if (reviewPath && !waiving("challenge")) {
        if (docs[reviewPath] === null || docs[reviewPath] === undefined) add(`challenge review ${task.challenge.review} does not exist (run /flow:challenge with an independent reviewer)`);
        else if (!/^\s*verdict:\s*pass\b/im.test(docs[reviewPath])) add(`challenge review ${task.challenge.review} does not say "verdict: pass"`);
      }
    }
    if ((task.signals ?? []).some((s) => rules.get(s)?.capacity) && !waiving("capacity")) {
      for (const e of capacityErrors(task.capacity, tier, waiving("measured-workload"))) add(e);
    }
    for (const d of task.decisions ?? []) if (!substantive(d.chosen)) add(`🔴 decision ${d.id} is open: "${esc(d.question)}" (decide it with the human and record "chosen")`);
    for (const a of task.challenge?.assumptions ?? []) {
      if (a.status !== "unverified") continue;
      if (a.blocks === "merge") add(`unverified assumption blocks merge: ${esc(a.text)}`);
      else if (a.blocks === "rollout") r.rolloutBlockers.push(esc(a.text));
      else r.unknowns.push(`unverified assumption (accepted): ${esc(a.text)}`);
    }

    // Evidence for every criterion; critical ones block.
    const evalCriteria = (task.criteria ?? []).filter((c) => c.verify === "eval");
    const criticalEval = evalCriteria.some((c) => c.severity === "critical");
    const evalsProblem = evalCriteria.length ? await evalsProblemFor(task, ctx, criticalEval) : null;
    const res = task.evals?.results;
    if (evalCriteria.length && res) {
      if ((res.safetyFailures ?? 0) > 0) add(`${res.safetyFailures} unresolved eval safety failure(s)`);
      if ((res.unknown ?? 0) > 0) {
        const note = `${res.unknown} eval result(s) not yet attributed (product defect, eval defect or safety)`;
        if (criticalEval) add(note); else r.unknowns.push(note);
      }
    }
    if (evalsProblem && !criticalEval) r.unknowns.push(`eval results don't count as evidence yet: ${evalsProblem}`);
    for (const c of task.criteria ?? []) {
      const dim = (r.dims[c.kind] ??= { total: 0, proven: 0, open: [] });
      dim.total++;
      if (c.verify === "canary") { dim.open.push(`${c.id} (canary, after deploy)`); continue; }
      const problems = [];
      let proven = false;
      for (const ref of task.evidence?.[c.id] ?? []) {
        const problem = await refProblem(ref, c, ctx, evalsProblem);
        if (problem) problems.push(problem); else proven = true;
      }
      if (proven) { dim.proven++; continue; }
      dim.open.push(c.id);
      const why = problems.length ? problems.join("; ") : "no evidence yet";
      if (c.severity === "critical") add(`critical ${c.kind} criterion ${c.id} is unproven: ${why}`);
      else r.unknowns.push(`${c.id} unproven: ${why}`);
    }

    // Integration: dependencies merged first, the combined system proven, a paired deploy planned.
    const deps = task.integration?.dependsOn ?? [];
    if (deps.length) {
      const dim = (r.dims.integration = { total: deps.length + 1, proven: 0, open: [] });
      if (!str(task.integration.owner)) add("integration.owner is required when the task depends on others");
      if (!substantive(task.integration.deployPlan)) add("integration.deployPlan is required (order and pairing of the deploys)");
      for (const dep of deps) {
        const problem = await dependencyProblem(dep, ctx);
        if (problem) { add(problem); dim.open.push(dep); } else dim.proven++;
      }
      const problems = [];
      let proven = false;
      for (const ref of task.evidence?.integration ?? []) {
        const problem = await refProblem(ref, { verify: "e2e" }, ctx, null);
        if (problem) problems.push(problem); else proven = true;
      }
      if (proven) dim.proven++;
      else { add(`no combined-system evidence (evidence.integration: ${problems.join("; ") || "empty"})`); dim.open.push("combined-system test"); }
    }

    // Independent verification: an approving review from a configured review bot, else the verifier's notes.
    if (tier !== "small" && !waiving("verify")) {
      const problem = await verifyProblem(ctx, id);
      if (problem) add(problem);
    }

    // Approvals. Medium work needs none unless it lowers its tier or waives something.
    if (overrideNeeded && !r.approved.override) {
      ask("override", r.hash, lowered ? `lowers the tier from ${floor} to ${task.tier}${waived.size ? ` and waives ${[...waived].join(", ")}` : ""}` : `waives ${[...waived].join(", ")}`);
    }
    if (tier === "high") {
      if (!r.approved.spec) ask("spec", r.hash, "the high-risk spec is not approved (task.json, design.md, the challenge review)");
      r.approved.ship = okApproval("ship", shipHash);
      if (!r.approved.ship) {
        if (r.blockers.length === 0) ask("ship", shipHash, "high risk: an approver authorizes these exact changes");
        else add("high risk: a ship approval of the final changes is needed once the other blockers are fixed");
      }
    }
  }

  for (const s of signals) {
    if (!listed.has(s.id)) blockers.push(`detected risk "${s.id}" (${s.why}; ${s.files.slice(0, 3).join(", ") || "whole diff"}) is not in any task's signals: add it (the spec changes)`);
  }
  for (const r of results) { blockers.push(...r.blockers); unknowns.push(...r.unknowns); }
  return {
    ok: blockers.length === 0, mode,
    tier: maxTier([detectedTier, ...results.map((r) => r.tier ?? "small")]),
    signals, tasks: results, blockers, unknowns, paste,
    stages: stagesFor(ctx, results),
    rolloutBlockers: results.flatMap((r) => r.rolloutBlockers),
    shipHash,
  };
}

/** A dependency counts once its own PR is merged: "ABC-1" (a task on the base branch whose "pr" merged) or "owner/repo#123". */
async function dependencyProblem(dep, ctx) {
  const cross = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(dep);
  if (cross) {
    const state = await ctx.prState(cross[1], Number(cross[2])).catch(() => null);
    if (!state) return `depends on ${dep}, which this gate can't read (give its token access to ${cross[1]})`;
    return state.merged ? null : `depends on ${dep}, which is not merged: merge it first`;
  }
  if (!TASK_ID.test(dep)) return `dependency "${dep}" must be a task id or owner/repo#123`;
  const raw = await ctx.read(`.flow/tasks/${dep}/task.json`, "base");
  if (raw === null) return `depends on ${dep}, which is not merged yet: merge it first`;
  let pr;
  try { pr = JSON.parse(raw).pr; } catch { return `depends on ${dep}, whose task.json on the base branch is not valid JSON`; }
  if (!Number.isInteger(pr) || pr < 1) return `depends on ${dep}, whose task has no "pr" on the base branch, so its code can't be shown merged`;
  const state = await ctx.prState(ctx.repo, pr);
  if (!state?.merged) return `depends on ${dep}, whose PR #${pr} is not merged`;
  if (!taskIdsFromBody(state.body).includes(dep)) return `depends on ${dep}, but PR #${pr} is not that task's PR (its body has no "Flow-Task: ${dep}")`;
  return null;
}

async function verifyProblem(ctx, id) {
  const bots = (ctx.config.reviewBots ?? []).map(lower);
  if (bots.length) {
    const latest = new Map();
    for (const review of ctx.reviews ?? []) if (bots.includes(lower(review.user?.login))) latest.set(lower(review.user.login), review);
    const ok = [...latest.values()].some((review) => review.state === "APPROVED" && review.commit_id === ctx.pr.headSha);
    return ok ? null : `no approving review from ${ctx.config.reviewBots.join(" or ")} on this commit`;
  }
  const notes = await ctx.read(`.flow/tasks/${id}/verify.md`, "head");
  if (notes === null) return "no independent verification (.flow/tasks/<ID>/verify.md from /flow:verify)";
  if (!/^\s*verdict:\s*pass\b/im.test(notes)) return 'verify.md does not say "verdict: pass"';
  return null;
}

/** Only what the gate can check itself: CI results, merge state, GitHub deployments of the merge commit, approvals. */
function stagesFor(ctx, results) {
  const ci = ctx.checks.filter((check) => !GATE_CHECKS.includes(check.name));
  const tested = ci.length === 0 ? "unknown" : ci.some((check) => check.status !== "completed") ? "running"
    : ci.every((check) => ["success", "neutral", "skipped"].includes(check.conclusion)) ? "pass" : "fail";
  const integrations = results.map((r) => r.dims?.integration).filter(Boolean);
  const live = (ctx.deployments ?? []).filter((d) => d.state === "success");
  const high = results.filter((r) => r.tier === "high");
  return {
    built: "pass",
    tested,
    integrated: integrations.length === 0 ? "n/a" : integrations.every((d) => d.open.length === 0) ? "pass" : "unknown",
    merged: ctx.pr.merged ? "pass" : "no",
    deployed: !ctx.pr.merged ? "no" : live.length ? `pass: ${[...new Set(live.map((d) => d.environment))].join(", ")}` : "unknown",
    authorized: high.length === 0 ? "n/a" : high.every((r) => r.approved.ship) ? "pass" : "pending",
  };
}

// ---------- rendering ----------

const icon = (state = "") => state.startsWith("pass") ? "✅" : state === "n/a" ? "➖" : state === "no" ? "⬜" : state === "fail" ? "❌" : state === "running" ? "⏳" : "❔";

/** One Markdown dashboard for the PR comment, the check run and `flow status`. */
export function render(result, { pr } = {}) {
  const out = [];
  const head = result.error ? "❌ flow: error" : result.skipped ? "➖ flow: not judged here" : result.ok ? "✅ flow: pass" : `❌ flow: ${result.blockers.length} blocker${result.blockers.length === 1 ? "" : "s"}`;
  out.push(`### ${head}${result.tier ? ` · ${result.tier} risk` : ""}${pr ? ` · PR #${pr}` : ""}`);
  if (result.error) { out.push("", esc(result.error), "", "The gate fails closed: fix the cause above, then push or comment `/flow` to re-run."); return out.join("\n"); }
  if (result.skipped) { out.push("", result.skipped); return out.join("\n"); }
  if (result.signals.length) out.push("", `**Risk detected:** ${result.signals.map((s) => `\`${s.id}\` ${s.why}`).join(" · ")}`);
  if (result.small) out.push("", "Small change: no risk rules matched, so no task or approval is needed.");
  const stages = result.stages ?? {};
  out.push("", ["built", "tested", "integrated", "merged", "deployed", "authorized"].map((stage) => `${icon(stages[stage])} ${stage}`).join(" → "));
  if (stages.deployed?.startsWith("pass")) out.push("", `Deployed (GitHub deployments): ${stages.deployed.slice(6)}`);
  for (const r of result.tasks) {
    out.push("", `#### ${r.id}${r.title ? ` · ${esc(r.title)}` : ""}${r.tier ? ` · ${r.tier}` : ""}`);
    if (!r.task) continue;
    if (r.lowered) out.push("", `⚠️ **Tier override:** declared ${r.lowered.to}, its signals say ${r.lowered.from}${r.approved.override ? " (approved)" : ""}`);
    const rows = [];
    if (r.task.capacity) {
      for (const group of ["workload", "latency", "cost"]) {
        for (const [name, m] of Object.entries(r.task.capacity[group] ?? {})) {
          rows.push([`${group}.${name}`, m?.source === "measured" ? "pass" : "estimate", `${esc(m?.value)} · ${m?.source === "measured" ? `measured ${esc(m?.at)}: ${esc(m?.ref)}` : `estimate: ${esc(m?.basis)}`}`]);
        }
      }
    }
    for (const kind of KINDS) {
      const d = r.dims[kind];
      if (d) rows.push([kind, d.open.length === 0 ? "pass" : "unknown", `${d.proven}/${d.total} proven${d.open.length ? `; open: ${d.open.join(", ")}` : ""}`]);
    }
    if (r.dims.integration) rows.push(["integration", r.dims.integration.open.length ? "unknown" : "pass", r.dims.integration.open.length ? `open: ${r.dims.integration.open.join(", ")}` : "dependencies merged, combined system proven"]);
    const res = r.task.evals?.results;
    if (res) rows.push(["evals (reported)", (res.safetyFailures ?? 0) > 0 ? "fail" : "info", `raw ${res.raw?.pass ?? "?"} pass / ${res.raw?.fail ?? "?"} fail over ${res.runs ?? "?"} run(s) · product defects ${res.productDefects ?? "?"} · safety ${res.safetyFailures ?? "?"} · eval defects ${res.evalDefects ?? "?"} · unknown ${res.unknown ?? "?"}`]);
    if (r.tier === "high") {
      rows.push(["spec approval", r.approved.spec ? "pass" : "pending", `spec@${r.hash}`]);
      rows.push(["ship approval", r.approved.ship ? "pass" : "pending", `ship@${result.shipHash} (these exact changes)`]);
    }
    if (rows.length) out.push("", "| | | |", "|---|---|---|", ...rows.map(([name, state, detail]) => `| ${name} | ${icon(state)} ${state} | ${detail} |`));
    if (r.rolloutBlockers?.length) out.push("", `Rollout blocked until verified: ${r.rolloutBlockers.join("; ")}`);
  }
  if (result.blockers.length) out.push("", "**Blockers**", ...result.blockers.map((b) => `- ${b}`));
  if (result.unknowns.length) out.push("", "**Unknown** (shown, not blocking)", ...result.unknowns.map((u) => `- ${u}`));
  if (result.paste.length) {
    const how = result.mode === "signed" ? "run `node .github/flow/flow.mjs approve <line> --pr N` on your machine and post what it prints" : "post each line as its own PR comment";
    out.push("", `**Approver: review, then ${how}**`, "```", ...result.paste, "```");
  }
  out.push("", `<sub>approvals: ${result.mode === "signed" ? "SSH-signed by config.signers" : "login-based (config.approvers)"}</sub>`);
  return out.join("\n");
}
