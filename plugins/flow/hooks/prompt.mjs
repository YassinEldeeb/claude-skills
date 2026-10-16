// UserPromptSubmit. Never blocks. Three jobs, one process:
// 1. token warning (flow 2.0's context guard): idle past the cache TTL with a big context, or over 500k tokens;
// 2. session constraints the engineer states ("don't merge"): noted, then re-injected on every prompt;
// 3. feedback capture (flow 2.1): a correction, praise or preference becomes a small redacted event in the local queue.
// Fails open: any error lets the prompt through untouched.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { classifyPrompt, constraintChanges, isAutomated } from "../learn/classify.mjs";
import { appendLog, captureAllowed, clean, enqueue, loadSession, safe, saveSession } from "../learn/store.mjs";
import { PLUGIN_VERSION, constraintRules, describeConstraints, repoFlowConfig, repoOf, typedByEngineer } from "./capture.mjs";

const started = Date.now();
const TTL_MIN = Number(process.env.FLOW_CACHE_TTL_MIN) || 60;
const BIG = 150_000, HUGE = 500_000;

function contextWarning(path) {
  if (!path || !existsSync(path)) return null;
  const size = statSync(path).size, take = Math.min(size, 4 * 1024 * 1024);
  const buf = Buffer.alloc(take), fd = openSync(path, "r");
  readSync(fd, buf, 0, take, size - take);
  closeSync(fd);
  let lastAt = 0, context = 0;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const record = JSON.parse(line);
      const usage = record?.message?.usage;
      if (record.type !== "assistant" || !usage || record.isSidechain) continue;
      lastAt = Date.parse(record.timestamp) || lastAt;
      context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    } catch { /* skip a bad line */ }
  }
  if (!lastAt) return null;
  const k = Math.round(context / 1000), idleMin = Math.round((Date.now() - lastAt) / 60_000);
  const notes = [];
  if (idleMin > TTL_MIN && context > BIG) notes.push(`idle ${idleMin} min with ${k}k tokens of context: the prompt cache (TTL ${TTL_MIN} min) has likely expired, so this message re-reads all ${k}k. Before a long pause, write the state to the task and /compact.`);
  if (context > HUGE) notes.push(`context is ${k}k tokens: past 500k every request costs more and quality drops. Write the state to files and /compact or start fresh.`);
  return notes.length ? `[flow] ${notes.join(" ")}` : null;
}

try {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  const system = safe(() => contextWarning(input.transcript_path), null);
  const context = [];
  const human = typedByEngineer(input) && !isAutomated(input.prompt);

  if (human) {
    safe(() => {
      const rules = constraintRules();
      const session = loadSession(input.session_id);
      const active = new Set(session.constraints ?? []);
      const { start, release } = constraintChanges(input.prompt, rules);
      for (const id of start) active.add(id);
      for (const id of release) active.delete(id);
      if (start.length || release.length) {
        session.constraints = [...active];
        appendLog("constraints.jsonl", { at: new Date().toISOString(), session: input.session_id, start, release });
        if (start.length) context.push(`[flow] Constraint noted for this session: ${describeConstraints(start, rules).join("; ")}. Hooks refuse it until the engineer lifts it.`);
        if (release.length) context.push(`[flow] Constraint lifted by the engineer: ${describeConstraints(release, rules).join("; ")}.`);
      }
      const { root, name } = repoOf(input.cwd || process.cwd());
      if (captureAllowed(repoFlowConfig(root))) {
        session.prompts = (session.prompts ?? 0) + 1;
        session.objective ??= clean(input.prompt, 200);
        const verdict = classifyPrompt(input.prompt);
        if (verdict && verdict.kind !== "noise") {
          enqueue({
            type: "prompt", at: new Date().toISOString(), session: input.session_id, repo: name,
            kind: verdict.kind, category: verdict.category ?? null, keys: verdict.keys ?? [],
            text: verdict.kind === "positive" ? null : clean(input.prompt, 300),
            objective: session.objective, promptIndex: session.prompts,
            model: session.model ?? null, version: PLUGIN_VERSION,
          });
          if (verdict.kind === "correction") (session.corrections ??= []).push({ category: verdict.category, at: Date.now() });
        }
        appendLog("hook-latency.jsonl", { at: new Date().toISOString(), hook: "prompt", ms: Date.now() - started });
      }
      saveSession(input.session_id, session);
    });
  }

  const still = human ? safe(() => loadSession(input.session_id).constraints ?? [], []) : [];
  if (still.length && !context.some((c) => c.includes("Constraint noted"))) {
    context.push(`[flow] Active constraints the engineer set this session: ${describeConstraints(still, constraintRules()).join("; ")}.`);
  }
  const output = {};
  if (system) output.systemMessage = system;
  if (context.length) output.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: context.join("\n") };
  if (Object.keys(output).length) process.stdout.write(JSON.stringify(output));
  process.exit(0);
} catch {
  process.exit(0);
}
