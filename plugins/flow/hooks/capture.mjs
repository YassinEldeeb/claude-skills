// Shared by flow's prompt, session and guard hooks: who typed a prompt, constraint rules, session constraints.
// Pure helpers plus small file reads; callers wrap them so a failure never blocks work.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadSession } from "../learn/store.mjs";

const here = dirname(new URL(import.meta.url).pathname);
// The plugin's version (the gate in repos keeps its own FLOW_VERSION; it didn't change in 2.1).
export const PLUGIN_VERSION = "2.4.1";

/**
 * A prompt an engineer typed: Claude Code marks it source "user" (verified in 2.1.301's schema). The field may be
 * absent (it is in -p mode), so then only an attended session counts: headless children set CLAUDE_CODE_SESSION_ATTENDED=0.
 * /loop and schedule wakeups, SDK relays and eval runs never count.
 */
export const typedByEngineer = (input, env = process.env) => {
  if (env.FLOW_FEEDBACK === "off") return false;
  if (input.source === "user") return true;
  // The VS Code and Desktop apps drive Claude Code non-interactively, so their prompts come as source "sdk" (seen in the
  // 2.1.301 binary) while the session is attended: those are still typed by the engineer.
  if (input.source === "sdk") return env.CLAUDE_CODE_SESSION_ATTENDED === "1" && ["claude-vscode", "claude-desktop"].includes(env.CLAUDE_CODE_ENTRYPOINT);
  return input.source == null && env.CLAUDE_CODE_SESSION_ATTENDED !== "0";
};

/** The constraint rules shipped with the plugin (FLOW_CONSTRAINT_RULES overrides the path, for evals of a candidate tree). */
export function constraintRules() {
  const file = process.env.FLOW_CONSTRAINT_RULES || join(here, "constraint-rules.json");
  try { return JSON.parse(readFileSync(file, "utf8")).rules ?? []; } catch { return []; }
}

export const activeConstraints = (sessionId) => loadSession(sessionId).constraints ?? [];

/** The repo root and name for a cwd, by walking up to a .git entry (no git process: this runs on every prompt). */
export function repoOf(cwd) {
  let dir = cwd;
  for (let i = 0; i < 40 && dir; i++) {
    if (existsSync(join(dir, ".git"))) return { root: dir, name: basename(dir) };
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { root: null, name: null };
}

export function repoFlowConfig(root) {
  try { return root ? JSON.parse(readFileSync(join(root, ".flow/config.json"), "utf8")) : null; } catch { return null; }
}

export const describeConstraints = (ids, rules) => ids.map((id) => rules.find((r) => r.id === id)?.why ?? id);
