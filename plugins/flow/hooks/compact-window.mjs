// flow 2.4.4: Claude Code compacts a session by itself once its context nears `autoCompactWindow`. A plugin's own
// settings.json can't set that key, so flow writes it to the engineer's user settings, instead of asking them to
// /compact. flow decides once: it never overrides a window they chose (and leaves it to them for good), never writes
// when compaction is off, and never sets it again after they remove it.
import { accessSync, chmodSync, constants, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const COMPACT_WINDOW = 500_000;

const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const userSettingsPath = () => join(configDir(), "settings.json");
// Claude Code keeps /config toggles (autoCompactEnabled among them) in .claude.json, beside the config dir by default.
const globalConfigPath = () => process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");

const readObject = (file) => {
  if (!existsSync(file)) return { raw: null, value: {} };
  const raw = readFileSync(file, "utf8");
  const value = raw.trim() === "" ? {} : JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file} is not a JSON object`);
  return { raw, value };
};

const truthyEnv = (name) => /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
const compactionOff = () => truthyEnv("DISABLE_COMPACT") || truthyEnv("DISABLE_AUTO_COMPACT") || (() => {
  try {
    const file = globalConfigPath();
    // .claude.json can grow large (project history); a window set while compaction is off turns nothing on anyway.
    return existsSync(file) && statSync(file).size < 8 * 1024 * 1024 && readObject(file).value.autoCompactEnabled === false;
  } catch { return false; }
})();

// The window a new session gets: a number of tokens, "env"/"custom" for a value flow can't read as one,
// "off" when compaction is off, or null when nothing is set (Claude Code's own default, close to the full context).
// Only user settings and the environment: project or managed settings can differ, so callers stay modest.
export function configuredWindow() {
  if (compactionOff()) return "off";
  const env = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (env) return Number(env) > 0 ? Number(env) : "env";
  const { value } = readObject(userSettingsPath());
  if (value.autoCompactEnabled === false) return "off";
  return typeof value.autoCompactWindow === "number" ? value.autoCompactWindow : value.autoCompactWindow == null ? null : "custom";
}

// The settings text with the key added, keeping the file's own formatting (indentation, line endings, everything
// else byte for byte); a JSON round trip only when the text has no shape to insert into.
function withWindow(raw, value) {
  const expected = { ...value, autoCompactWindow: COMPACT_WINDOW };
  if (raw && raw.trim() !== "") {
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? "  ";
    const end = raw.trimEnd(), close = end.lastIndexOf("}");
    if (close === end.length - 1) {
      const before = end.slice(0, close).trimEnd();
      const text = `${before}${before.endsWith("{") ? "" : ","}${eol}${indent}"autoCompactWindow": ${COMPACT_WINDOW}${eol}}${raw.slice(end.length)}`;
      try { if (JSON.stringify(JSON.parse(text)) === JSON.stringify(expected)) return text; } catch { /* fall through */ }
    }
  }
  return `${JSON.stringify(expected, null, 2)}\n`;
}

// Sets autoCompactWindow once, in a session a person attends. Returns the line to show the engineer, or null.
// `config`/`saveConfig` are flow's own store, which remembers that flow already decided.
export function ensureCompactWindow({ config, saveConfig }) {
  if (process.env.CLAUDE_CODE_SESSION_ATTENDED !== "1") return null;
  if (config().compactWindowSetAt || config().compactWindowLeftAt) return null;
  if (!existsSync(configDir())) return null;
  const file = userSettingsPath();
  const decided = (key) => { saveConfig({ ...config(), [key]: new Date().toISOString() }); };
  // The environment decides for this session only: try again next time.
  if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) return null;
  const { raw, value } = readObject(file);
  // The engineer already chose (a window anywhere in the file, top level or per model, or compaction off): theirs for good.
  if (raw?.includes('"autoCompactWindow"') || value.autoCompactEnabled === false || compactionOff()) { decided("compactWindowLeftAt"); return null; }
  // A link to nowhere, or a file the engineer can't write: leave it.
  let target = file;
  if (raw === null && (() => { try { return lstatSync(file).isSymbolicLink(); } catch { return false; } })()) return null;
  if (raw !== null) {
    target = realpathSync(file);
    try { accessSync(target, constants.W_OK); } catch { return null; }
  }
  const tmp = `${target}.flow-${process.pid}.tmp`;
  writeFileSync(tmp, withWindow(raw, value), { mode: 0o600 });
  try {
    if (raw !== null) chmodSync(tmp, statSync(target).mode & 0o777);
    // Another writer (a /config change, another session) got there first: leave their file alone, try next session.
    // (A write landing between this check and the rename can still be lost; that window is microseconds.)
    const now = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (now !== raw) return null;
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  decided("compactWindowSetAt");
  return `[flow] Claude Code now compacts a session by itself as it nears 500k tokens: flow set "autoCompactWindow": ${COMPACT_WINDOW} in ${file}. New and resumed sessions use it; a session already open keeps its old window until it restarts. Change it with /autocompact; flow won't set it again.`;
}
