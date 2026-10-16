// PreToolUse (Edit, Write, MultiEdit, NotebookEdit), best effort:
// - a high-risk task's code waits for its approved spec (only .flow/ and docs can change before that);
// - an edit that trips a high-risk rule no task on this branch lists is routed through a task first;
// - approval records are never written by an agent.
// Fails open; the CI gate is what actually blocks a merge.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { approveLine, fileSignals } from "../gate/lib.mjs";
import { block, branchTasks, currentBranch, loadFlow, readInput, repoRoot } from "./common.mjs";

/** Resolve symlinks (macOS /var -> /private/var) even for a file that doesn't exist yet. */
const real = (path) => existsSync(path) ? realpathSync(path) : dirname(path) === path ? path : join(real(dirname(path)), basename(path));

try {
  const input = await readInput();
  const tool = input.tool_input ?? {};
  const target = tool.file_path ?? tool.notebook_path;
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!target) process.exit(0);
  const root = repoRoot(cwd);
  const flow = loadFlow(root);
  if (!flow) process.exit(0);
  const full = isAbsolute(target) ? target : join(cwd, target);
  const rel = relative(realpathSync(root), real(full)).split("\\").join("/");
  if (rel.startsWith("..")) process.exit(0);
  if (/^\.flow\/tasks\/[^/]+\/\.approved$/.test(rel)) block("Approval records are written only by `node .github/flow/flow.mjs sync <ID>` after a human approved on the PR. Never write them yourself.");
  // Task specs and docs stay editable; .flow/config.json goes through the risk check below (it is the gate's config).
  if (rel.startsWith(".flow/tasks/") || /\.(md|mdx|txt)$/i.test(rel)) process.exit(0);

  const mine = branchTasks(flow, currentBranch(root));
  const before = flow.config.approvalBeforeBuild ?? ["high"];
  const held = mine.find((t) => before.includes(t.task.tier) && !t.approved);
  if (held) {
    block(`Task ${held.id} is ${held.task.tier} risk and its spec is not approved yet, so code edits wait (checkpoint 1). Finish the spec (task.json, design.md, the challenge review), open or update the draft PR, and ask the human to post \`${approveLine(held.id, "spec", held.hash)}\`. Then run \`node .github/flow/flow.mjs sync ${held.id}\`. Until then edit only .flow/ and docs.`);
  }

  const text = tool.content ?? tool.new_string ?? tool.new_source ?? (tool.edits ?? []).map((e) => e.new_string ?? "").join("\n");
  const file = { filename: rel, status: existsSync(full) ? "modified" : "added", patch: String(text).split("\n").map((line) => `+${line}`).join("\n") };
  const listed = new Set(mine.flatMap((t) => t.task.signals ?? []));
  const missing = fileSignals(file, flow.config).filter((rule) => rule.tier === "high" && rule.id !== "unscanned" && !listed.has(rule.id));
  if (missing.length) {
    block(`This edit to ${rel} is high risk (${missing.map((r) => `${r.id}: ${r.why}`).join("; ")}) and no task on this branch lists it. Run /flow:start to classify and spec the work first${mine.length ? `, or add the signal to ${mine.map((t) => t.id).join("/")} (its spec then needs re-approval)` : ""}.`);
  }
  process.exit(0);
} catch {
  process.exit(0);
}
