// flow learn: local storage. Text hygiene, consent, the durable file queue, session state and append-only logs.
// Everything lives under FLOW_FEEDBACK_HOME (default ~/.claude/flow-feedback), mode 0600, and never leaves the machine.
// Hooks call into this file, so callers wrap it in `safe`: telemetry must never break work.
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const home = () => process.env.FLOW_FEEDBACK_HOME || join(homedir(), ".claude", "flow-feedback");
export const path = (...parts) => join(home(), ...parts);
const ensure = (dir) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
export const RETENTION_DAYS = 30;

// ---------- text hygiene ----------

// A field where any of these fire is dropped whole: redacting a secret still leaks its shape and its neighbours.
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i,
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\b\s*[:=]/i,
  /\b[A-Z][A-Z0-9_]{2,}_(KEY|TOKEN|SECRET|PASSWORD)\s*=/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/,
  /"type"\s*:\s*"service_account"/,
  /https:\/\/hooks\.(slack|zapier)\.com\/\S+|https:\/\/discord(app)?\.com\/api\/webhooks\/\S+/i,
  /\b(?:\d[ -]?){13,19}\b/, // card-like digit runs
];
/** A long token mixing cases and digits with high entropy: probably a credential. */
const entropic = (text) => (String(text).match(/[A-Za-z0-9+/_=-]{24,}/g) ?? []).some((token) => {
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) return false;
  const counts = {};
  for (const ch of token) counts[ch] = (counts[ch] ?? 0) + 1;
  const entropy = -Object.values(counts).reduce((sum, n) => sum + (n / token.length) * Math.log2(n / token.length), 0);
  return entropy > 4;
});
export const looksSecret = (text) => SECRET.some((re) => re.test(String(text ?? ""))) || entropic(text);

/**
 * Text that may be stored: null when it carries a secret (drop the field, keep the category); otherwise personal data
 * is redacted (emails, phones, IPs, home paths) and the length capped.
 */
export function clean(text, max = 300) {
  const raw = String(text ?? "");
  if (!raw.trim() || looksSecret(raw)) return null;
  let out = raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "[phone]" : m))
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .split(homedir()).join("~")
    .replace(/\/(Users|home)\/[^/\s]+/g, "/$1/[user]")
    .replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// ---------- config and consent ----------

const DEFAULTS = { capture: true, prs: false, maxNewPrsPerDay: 2, maxOpenPrs: 5, eval: { runs: 5, model: null } };

export function config() {
  try {
    const saved = existsSync(path("config.json")) ? JSON.parse(readFileSync(path("config.json"), "utf8")) : {};
    return { ...DEFAULTS, ...saved, eval: { ...DEFAULTS.eval, ...(saved.eval ?? {}) } };
  } catch { return { ...DEFAULTS }; }
}
export function saveConfig(value) { ensure(home()); writeFileSync(path("config.json"), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }

/**
 * May this prompt's session be captured? Off with FLOW_FEEDBACK=off or `flow-learn disable`. A repo whose flow config
 * says learn.capture = "opt-in" (team installs) captures only after the engineer ran `flow-learn enable` (enabledAt set).
 */
export function captureAllowed(repoConfig) {
  if (process.env.FLOW_FEEDBACK === "off") return false;
  const c = config();
  if (c.capture === false) return false;
  if (repoConfig?.learn?.capture === "opt-in" && !c.enabledAt) return false;
  return true;
}

// ---------- durable queue: pending/ -> processing/ -> (deleted) | dead/ ----------

const qdir = (name) => ensure(path("queue", name));

/** Write an event atomically: a temp file renamed into pending/, so a reader never sees half an event. */
export function enqueue(event) {
  const id = event.id ?? `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const tmp = join(qdir("pending"), `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ ...event, id }), { mode: 0o600 });
  renameSync(tmp, join(qdir("pending"), `${id}.json`));
  return id;
}

/** Claim events by renaming pending/ -> processing/ (atomic: two workers never claim one file). Stale claims come back first. */
export function claim(limit = 1000, staleMs = 10 * 60_000) {
  const now = Date.now();
  for (const name of readdirSync(qdir("processing"))) {
    const file = join(qdir("processing"), name);
    try { if (now - statSync(file).mtimeMs > staleMs) renameSync(file, join(qdir("pending"), name)); } catch { /* taken */ }
  }
  const claimed = [];
  for (const name of readdirSync(qdir("pending")).filter((n) => n.endsWith(".json")).sort().slice(0, limit)) {
    const to = join(qdir("processing"), name);
    try { renameSync(join(qdir("pending"), name), to); } catch { continue; }
    try { claimed.push({ file: to, event: JSON.parse(readFileSync(to, "utf8")) }); }
    catch { try { renameSync(to, join(qdir("dead"), name)); } catch { /* gone */ } }
  }
  return claimed;
}
export const ack = (item) => rmSync(item.file, { force: true });
export const queueCounts = () => Object.fromEntries(["pending", "processing", "dead"].map((name) => [name, existsSync(path("queue", name)) ? readdirSync(path("queue", name)).filter((n) => n.endsWith(".json")).length : 0]));

// ---------- sessions and logs ----------

const sessionFile = (id) => path("sessions", `${String(id ?? "unknown").replace(/[^\w.-]/g, "_")}.json`);
export function loadSession(id) {
  try { return JSON.parse(readFileSync(sessionFile(id), "utf8")); } catch { return {}; }
}
export function saveSession(id, state) {
  ensure(path("sessions"));
  const tmp = `${sessionFile(id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, sessionFile(id));
}

export function appendLog(name, record) { ensure(home()); appendFileSync(path(name), `${JSON.stringify(record)}\n`, { mode: 0o600 }); }
export function readLog(name) {
  if (!existsSync(path(name))) return [];
  return readFileSync(path(name), "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
export function writeLog(name, records) { ensure(home()); const tmp = path(`.${name}.tmp`); writeFileSync(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 }); renameSync(tmp, path(name)); }
export function readJson(name, fallback) { try { return JSON.parse(readFileSync(path(name), "utf8")); } catch { return fallback; } }
export function writeJson(name, value) { ensure(home()); const tmp = path(`.${name.replace(/\//g, "_")}.tmp`); writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); ensure(join(path(name), "..")); renameSync(tmp, path(name)); }

/** Drop records older than the retention window from a log; delete old session files. */
export function enforceRetention(now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  for (const name of ["incidents.jsonl", "sessions.jsonl", "hook-latency.jsonl"]) {
    const kept = readLog(name).filter((r) => !r.at || Date.parse(r.at) >= cutoff);
    if (existsSync(path(name))) writeLog(name, kept);
  }
  if (existsSync(path("sessions"))) {
    for (const name of readdirSync(path("sessions"))) {
      try { if (statSync(path("sessions", name)).mtimeMs < cutoff) rmSync(path("sessions", name), { force: true }); } catch { /* gone */ }
    }
  }
}

/** One worker at a time: an exclusive create; a lock older than staleMs (a crashed worker) is taken over. */
export function lock(staleMs = 30 * 60_000) {
  ensure(home());
  const file = path("worker.lock");
  try {
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs > staleMs) rmSync(file, { force: true });
    closeSync(openSync(file, "wx"));
    writeFileSync(file, String(process.pid));
    return () => rmSync(file, { force: true });
  } catch { return null; }
}

export function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
