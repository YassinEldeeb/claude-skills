// SessionStart (also after /compact): ground the agent in this branch's flow tasks, from files, in a few lines.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FLOW_VERSION, approveLine, substantive } from "../gate/lib.mjs";
import { captureAllowed, config, loadSession, safe, saveConfig, saveSession } from "../learn/store.mjs";
import { activeConstraints, constraintRules, describeConstraints, repoFlowConfig, typedByEngineer } from "./capture.mjs";
import { branchTasks, currentBranch, loadFlow, readInput, repoRoot } from "./common.mjs";

let newsSince = () => null;
try { if (config().autoLearn) ({ newsSince } = await import("../learn/auto.mjs")); } catch { /* fail open */ }
try {
  const input = await readInput().catch(() => ({}));
  const root = repoRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  // flow 2.1, in any repo: remember the model for this session's events; re-ground constraints after /compact or resume;
  // tell the engineer once that corrections are recorded locally.
  let notice = null;
  const learnLines = safe(() => {
    const lines = [];
    const attended = typedByEngineer({ source: null });
    if (!attended) return lines;
    const session = loadSession(input.session_id);
    if (input.model) session.model = input.model;
    const constraints = activeConstraints(input.session_id);
    if (constraints.length && ["compact", "resume"].includes(input.source)) lines.push(`[flow] Constraints the engineer set this session still hold: ${describeConstraints(constraints, constraintRules()).join("; ")}.`);
    if (captureAllowed(repoFlowConfig(root), root ? root.split("/").pop() : null) && !config().noticeShown) {
      // Shown to the engineer (systemMessage), not left for the model to relay; remembered in config.json.
      const cli = join(dirname(new URL(import.meta.url).pathname), "../learn/cli.mjs");
      notice = `[flow] flow records your corrections and session signals locally to improve its skills (redacted; nothing leaves this machine). To turn it off, run in your terminal: node "${cli}" disable (or set FLOW_FEEDBACK=off). Optional: type "flow auto-learn on" and, after a correction, flow tests a fix to its workflow in the background on your Claude plan and opens a draft PR (synthetic text only) when the fix is proven.`;
      saveConfig({ ...config(), noticeShown: new Date().toISOString() });
    }
    // What auto-learn did in the background, once per news item.
    const news = config().autoLearn ? newsSince(config().autoLearnShownAt ?? null) : null;
    if (news) { notice = notice ? `${notice}\n${news}` : news; saveConfig({ ...config(), autoLearnShownAt: new Date().toISOString() }); }
    saveSession(input.session_id, session);
    return lines;
  }, []);
  const flow = loadFlow(root);
  const emit = (lines) => {
    if (notice) process.stdout.write(JSON.stringify({ systemMessage: notice, ...(lines.length ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } } : {}) }));
    else if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
  };
  if (!flow) {
    // A flow 1.x repo: say how to upgrade, once per session.
    const legacy = root && existsSync(join(root, "status.md")) && existsSync(join(root, "decisions.md")) && existsSync(join(root, ".github/flow/check.mjs"));
    emit([...learnLines, ...(legacy ? [`[flow] This repo uses flow 1.x (status.md, decisions.md). The installed plugin is ${FLOW_VERSION}: run /flow:install to upgrade.`] : [])]);
    process.exit(0);
  }
  const branch = currentBranch(root);
  const lines = [`[flow ${FLOW_VERSION}] This repo uses flow: start any non-trivial task with /flow:start, which classifies the risk (small/medium/high) and runs every step itself. Rules: CLAUDE.md / AGENTS.md.`];
  const mine = branchTasks(flow, branch);
  for (const { id, task, hash, approved } of mine) {
    const open = (task.decisions ?? []).filter((d) => !substantive(d.chosen)).map((d) => d.id);
    const held = (flow.config.approvalBeforeBuild ?? ["high"]).includes(task.tier) && !approved;
    lines.push(`[flow] Task ${id} (${task.tier}) "${task.title}" is on this branch.${held
      ? ` Its spec is not approved: code edits are held until an approver posts \`${approveLine(id, "spec", hash)}\`${task.pr ? ` on PR #${task.pr}` : " on its draft PR"} and you run \`node .github/flow/flow.mjs sync ${id}\`.`
      : ""}${open.length ? ` Open 🔴 decisions: ${open.join(", ")}.` : ""} State lives in .flow/tasks/${id}/ (progress.md has the rounds); check it with \`node .github/flow/flow.mjs status ${id}\`. When the engineer's request is about this task, continue from its next step yourself.`);
  }
  if (!mine.length) lines.push("[flow] No task on this branch: fine for a small change; for medium or high work run /flow:start before editing code.");
  const repoLib = join(root, ".github/flow/lib.mjs");
  const repoVersion = existsSync(repoLib) ? /FLOW_VERSION = "([^"]+)"/.exec(readFileSync(repoLib, "utf8"))?.[1] : null;
  if (repoVersion && repoVersion !== FLOW_VERSION) lines.push(`[flow] The repo's gate is ${repoVersion}, the plugin is ${FLOW_VERSION}: run /flow:install to upgrade the gate (in its own PR).`);
  emit([...learnLines, ...lines]);
} catch {
  process.exit(0);
}
