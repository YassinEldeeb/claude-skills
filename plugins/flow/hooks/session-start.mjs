// SessionStart (also after /compact): ground the agent in this branch's flow tasks, from files, in a few lines.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLOW_VERSION, approveLine, substantive } from "../gate/lib.mjs";
import { branchTasks, currentBranch, loadFlow, readInput, repoRoot } from "./common.mjs";

try {
  const input = await readInput().catch(() => ({}));
  const root = repoRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const flow = loadFlow(root);
  if (!flow) {
    // A flow 1.x repo: say how to upgrade, once per session.
    if (root && existsSync(join(root, "status.md")) && existsSync(join(root, "decisions.md")) && existsSync(join(root, ".github/flow/check.mjs"))) {
      process.stdout.write(`[flow] This repo uses flow 1.x (status.md, decisions.md). The installed plugin is ${FLOW_VERSION}: run /flow:install to upgrade.\n`);
    }
    process.exit(0);
  }
  const branch = currentBranch(root);
  const lines = [`[flow ${FLOW_VERSION}] This repo uses flow: start any non-trivial task with /flow:start, which classifies the risk (small/medium/high) and routes it. Rules: CLAUDE.md / AGENTS.md.`];
  const mine = branchTasks(flow, branch);
  for (const { id, task, hash, approved } of mine) {
    const open = (task.decisions ?? []).filter((d) => !substantive(d.chosen)).map((d) => d.id);
    const held = (flow.config.approvalBeforeBuild ?? ["high"]).includes(task.tier) && !approved;
    lines.push(`[flow] Task ${id} (${task.tier}) "${task.title}" is on this branch.${held
      ? ` Its spec is not approved: code edits are held until an approver posts \`${approveLine(id, "spec", hash)}\`${task.pr ? ` on PR #${task.pr}` : " on its draft PR"} and you run \`node .github/flow/flow.mjs sync ${id}\`.`
      : ""}${open.length ? ` Open 🔴 decisions: ${open.join(", ")}.` : ""} State lives in .flow/tasks/${id}/; check it with \`node .github/flow/flow.mjs status ${id}\`.`);
  }
  if (!mine.length) lines.push("[flow] No task on this branch: fine for a small change; for medium or high work run /flow:start before editing code.");
  const repoLib = join(root, ".github/flow/lib.mjs");
  const repoVersion = existsSync(repoLib) ? /FLOW_VERSION = "([^"]+)"/.exec(readFileSync(repoLib, "utf8"))?.[1] : null;
  if (repoVersion && repoVersion !== FLOW_VERSION) lines.push(`[flow] The repo's gate is ${repoVersion}, the plugin is ${FLOW_VERSION}: run /flow:install to upgrade the gate (in its own PR).`);
  process.stdout.write(`${lines.join("\n")}\n`);
} catch {
  process.exit(0);
}
