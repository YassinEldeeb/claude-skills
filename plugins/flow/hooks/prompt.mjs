// UserPromptSubmit. Never blocks. Three jobs, one process:
// 1. token warning (flow 2.0's context guard): idle past the cache TTL with a big context, or over 500k tokens;
// 2. session constraints the engineer states ("don't merge"): noted, then re-injected on every prompt;
// 3. feedback capture (flow 2.1): a correction, praise or preference becomes a small redacted event in the local queue.
// Fails open: any error lets the prompt through untouched.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { classifyPrompt, constraintChanges, isAutomated, ownWords, spendGrant } from "../learn/classify.mjs";
import { autoSwitch, startDetached } from "../learn/auto.mjs";
import { appendLog, captureAllowed, clean, config, enqueue, loadSession, safe, saveConfig, saveSession } from "../learn/store.mjs";
import { PLUGIN_VERSION, constraintRules, describeConstraints, repoFlowConfig, repoOf, typedByEngineer } from "./capture.mjs";

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
  // No prompt text, nothing to record (and nothing to note or count).
  // Pasted blocks are someone else's words: they never grant spend, set constraints or count as corrections.
  const own = typeof input.prompt === "string" ? ownWords(input.prompt) : "";
  const human = own.trim() !== "" && typedByEngineer(input) && !isAutomated(own);

  if (human) {
    safe(() => {
      const rules = constraintRules();
      const session = loadSession(input.session_id);
      const active = new Set(session.constraints ?? []);
      const { start, release } = constraintChanges(own, rules);
      for (const id of start) active.add(id);
      for (const id of release) active.delete(id);
      if (start.length || release.length) {
        session.constraints = [...active];
        appendLog("constraints.jsonl", { at: new Date().toISOString(), session: input.session_id, start, release });
        if (start.length) context.push(`[flow] Constraint noted for this session: ${describeConstraints(start, rules).join("; ")}. Hooks refuse it until the engineer lifts it.`);
        if (release.length) context.push(`[flow] Constraint lifted by the engineer: ${describeConstraints(release, rules).join("; ")}.`);
      }
      // Auto-learn is the engineer's switch, from their own typed words only.
      const turn = autoSwitch(own);
      if (turn != null) {
        const c = config();
        saveConfig({ ...c, autoLearn: { ...(c.autoLearn ?? {}), enabled: turn } });
        context.push(turn
          ? "[flow] Auto-learn is on: after a correction, once the session has been idle for a while, flow analyzes what went wrong, tests a fix to the workflow in the background on the engineer's Claude plan, and opens a draft PR only when the fix is proven. Tell the engineer in one line; \"flow auto-learn off\" turns it off."
          : "[flow] Auto-learn is off. Tell the engineer in one line.");
      }
      const grant = spendGrant(own);
      if (grant != null) {
        session.spendApprovedUsd = grant;
        context.push(`[flow] The engineer approved up to $${grant} of eval spend this session.`);
      }
      const { root, name } = repoOf(input.cwd || process.cwd());
      if (captureAllowed(repoFlowConfig(root), name)) {
        session.prompts = (session.prompts ?? 0) + 1;
        session.objective ??= clean(own, 200);
        const verdict = classifyPrompt(own);
        if (verdict && verdict.kind !== "noise") {
          enqueue({
            type: "prompt", at: new Date().toISOString(), session: input.session_id, repo: name,
            kind: verdict.kind, category: verdict.category ?? null, keys: verdict.keys ?? [],
            text: verdict.kind === "positive" ? null : clean(own, 300),
            objective: session.objective, promptIndex: session.prompts,
            model: session.model ?? null, version: PLUGIN_VERSION,
          });
          if (verdict.kind === "correction") {
            (session.corrections ??= []).push({ category: verdict.category, at: Date.now() });
            // Detached: it waits for this session to go idle, then works in the background (no-op when off).
            safe(() => startDetached({ session: input.session_id, transcript: input.transcript_path }));
          }
        }
        // Time since the process started, module loading included (Node's own startup before that is not visible here).
        appendLog("hook-latency.jsonl", { at: new Date().toISOString(), hook: "prompt", ms: Math.round(performance.now()) });
      }
      saveSession(input.session_id, session);
    });
  }

  // A paste-only prompt still gets the reminder: constraints are the engineer's, whoever wrote this prompt's text.
  const attended = typeof input.prompt === "string" && input.prompt.trim() !== "" && typedByEngineer(input) && !isAutomated(input.prompt);
  const still = attended ? safe(() => loadSession(input.session_id).constraints ?? [], []) : [];
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
