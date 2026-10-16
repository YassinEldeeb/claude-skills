// Shared helpers for flow's hooks. Hooks are best effort: every hook fails open, CI is the hard gate.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { specDocPaths, specHash } from "../gate/lib.mjs";

export async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text || "{}");
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
export function repoRoot(dir) { try { return git(dir, "rev-parse", "--show-toplevel"); } catch { return null; } }
export function currentBranch(root) { try { return git(root, "rev-parse", "--abbrev-ref", "HEAD"); } catch { return null; } }

const read = (root, path) => { const full = join(root, path); return existsSync(full) ? readFileSync(full, "utf8") : null; };

/** The repo's flow config and tasks, or null when the repo doesn't use flow 2. */
export function loadFlow(root) {
  const text = root && read(root, ".flow/config.json");
  if (!text) return null;
  const config = JSON.parse(text);
  const tasks = [];
  const dir = join(root, ".flow/tasks");
  for (const id of existsSync(dir) ? readdirSync(dir) : []) {
    const raw = read(root, `.flow/tasks/${id}/task.json`);
    if (!raw) continue;
    try {
      const task = JSON.parse(raw);
      const docs = Object.fromEntries(specDocPaths(task).map((path) => [path, read(root, path)]));
      const hash = specHash(task, docs);
      const synced = read(root, `.flow/tasks/${id}/.approved`) ?? "";
      tasks.push({ id, task, hash, approved: synced.startsWith(`spec@${hash} `) });
    } catch { /* a broken task file is the gate's to report */ }
  }
  return { config, tasks };
}

export const branchTasks = (flow, branch) => flow.tasks.filter((t) => branch && t.task.branch === branch);

export function block(message) {
  process.stderr.write(`[flow] ${message}\n`);
  process.exit(2);
}
