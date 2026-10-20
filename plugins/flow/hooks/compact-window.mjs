// flow 2.4.4: Claude Code compacts a session by itself once its context passes `autoCompactWindow`. A plugin's own
// settings.json can't set that key, so flow writes it to the engineer's user settings once, instead of asking them
// to /compact. It never overrides a value they chose, never turns compaction on when they turned it off, and never
// sets it again after they remove it.
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const compactionOff = () => truthyEnv("DISABLE_COMPACT") || truthyEnv("DISABLE_AUTO_COMPACT")
  || (() => { try { return readObject(globalConfigPath()).value.autoCompactEnabled === false; } catch { return false; } })();

// The window a new session gets: a number of tokens, "env"/"custom" for a value flow can't read as one,
// "off" when compaction is off, or null when nothing is set (Claude Code's own default, close to the full context).
export function configuredWindow() {
  const env = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (env) return Number.isFinite(Number(env)) ? Number(env) : "env";
  if (compactionOff()) return "off";
  const { value } = readObject(userSettingsPath());
  if (value.autoCompactEnabled === false) return "off";
  return typeof value.autoCompactWindow === "number" ? value.autoCompactWindow : value.autoCompactWindow == null ? null : "custom";
}

// Sets autoCompactWindow once. Returns the line to show the engineer, or null when nothing changed.
// `state` is flow's own config (config()/saveConfig) so a removal by the engineer is never undone.
export function ensureCompactWindow({ config, saveConfig }) {
  if (config().compactWindowSetAt) return null;
  if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || compactionOff()) return null;
  const file = userSettingsPath();
  if (!existsSync(configDir())) return null;
  const { raw, value } = readObject(file);
  // Any autoCompactWindow, top level or per model, is the engineer's choice.
  if (raw?.includes('"autoCompactWindow"') || value.autoCompactEnabled === false) return null;
  const indent = raw ? (/\n([ \t]+)"/.exec(raw)?.[1] ?? "  ") : "  ";
  const next = `${JSON.stringify({ ...value, autoCompactWindow: COMPACT_WINDOW }, null, indent)}\n`;
  const target = raw === null ? file : realpathSync(file);
  const tmp = `${target}.flow-${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  try {
    if (raw !== null) chmodSync(tmp, statSync(target).mode & 0o777);
    // Another writer (a /config change, another session) got there first: leave their file alone, try next session.
    const now = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (now !== raw) return null;
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  saveConfig({ ...config(), compactWindowSetAt: new Date().toISOString() });
  return `[flow] Claude Code now compacts a session by itself as it nears 500k tokens: flow set "autoCompactWindow": ${COMPACT_WINDOW} in ${file}. New and resumed sessions use it; a session already open keeps its old window until it restarts. Change it with /autocompact; flow won't set it again.`;
}
