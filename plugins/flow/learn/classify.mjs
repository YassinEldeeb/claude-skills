// flow learn: deterministic classification of engineer prompts and of session transcripts.
// No model calls: a lexicon plus guards. Testable, cheap, and immune to instructions hidden in feedback.
// Its recall is limited by design; `flow-learn report` states precision and recall on a labelled set.

export const CATEGORIES = [
  "outcome-drift", "overengineering", "architecture", "performance", "decision-latency", "timelines",
  "instruction-loss", "verification", "unauthorized-action", "communication", "tool-inefficiency", "eval-method",
  "unclassified",
];

// [category, key, pattern]. Keys form the fingerprint, so clustering never depends on free text.
const CORRECTIONS = [
  ["unauthorized-action", "merge", /\b(i (said|told you|asked you)|you were told|didn'?t i (say|tell you))\b[^.?!]{0,40}\b(not?|never|don'?t)\b[^.?!]{0,25}\bmerg/i],
  ["unauthorized-action", "merge", /\bwhy (did|would) you merge\b|\bwho (told|asked) you to merge\b|\byou (merged|shouldn'?t have merged)\b/i],
  ["unauthorized-action", "push", /\b(i (said|told you)|you were told)\b[^.?!]{0,40}\b(not?|never|don'?t)\b[^.?!]{0,25}\b(push|deploy|delete|force)/i],
  ["unauthorized-action", "push", /\bwhy (did|would) you (push|deploy|delete|force[- ]push|drop)\b/i],
  ["outcome-drift", "proxy-data", /\bwhy (didn'?t|did you not|haven'?t) you (query|use|check|look at|measure|pull)\b[^.?!]{0,60}\b(actual|real|production|paying|live)\b/i],
  ["outcome-drift", "proxy-data", /\b(not|isn'?t) (the )?(real|actual|right) (data|numbers|metric|customers)\b|\bthat'?s (a proxy|hypothetical|made[- ]up)\b|\b(hypothetical|made[- ]up|fake) (data|numbers)\b/i],
  ["outcome-drift", "wrong-problem", /\b(you'?re|you are) (solving|answering|building) the wrong (problem|question|thing)\b|\bthat'?s not what i asked\b|\bnot what i (asked|wanted)\b/i],
  ["outcome-drift", "missed-deliverable", /\b(still )?(haven'?t|didn'?t|never) (delivered|sent|written|produced|finished) (the|my|a)\b|\bwhere is the (report|deliverable|pr|doc)\b/i],
  ["outcome-drift", "drifting", /\b(you'?re|you are|stop) drifting\b|\bstop investigating and\b|\bfocus on the (goal|task|deliverable)\b/i],
  ["overengineering", "overengineering", /\bover[- ]?engineer|\btoo (complex|complicated|much abstraction|many abstractions)\b|\bwhy (so|this|is this so) (complex|complicated)\b|\byagni\b|\bunnecessary (abstraction|complexity|layers?)\b/i],
  ["architecture", "data-model", /\b(this|the) (schema|data model|table design|model) is (terrible|wrong|bad|broken|awful)\b|\bwrong (schema|data model|abstraction)\b/i],
  ["performance", "performance", /\b(too|way too|so) slow\b|\bthis (will not|won'?t) scale\b|\bn\+1\b|\bperformance (problem|issue)\b/i],
  ["decision-latency", "late-escalation", /\bwhy didn'?t you (catch|flag|raise|tell me|ask)\b[^.?!]{0,30}\b(earlier|sooner|before)\b|\bshould have (asked|flagged|escalated) (earlier|sooner)\b/i],
  ["timelines", "eta", /\b(your |the )?(eta|estimate|timeline)s? (was|were|is) (unrealistic|wrong|way off|off)\b/i],
  ["instruction-loss", "forgot", /\byou forgot (my|the|what i)\b|\bi (already )?told you (to|not to|that)\b|\bremember (that )?i (said|asked)\b/i],
  ["verification", "unverified-claim", /\b(you said|you claimed) (it was |it'?s )?(done|fixed|working|passing)\b|\bdid you (even )?(test|run|verify|check) (it|this|that)\b/i],
  ["communication", "verbose", /\b(too (long|verbose|wordy)|wall of text|get to the point|be (more )?concise)\b/i],
  ["tool-inefficiency", "tooling", /\bstop (re-?running|running the same|calling)\b|\bwhy are you (re-?)?(reading|running|searching) (it|that|this) again\b/i],
  ["eval-method", "eval-method", /\b(the |your )?(eval|benchmark|judge|scorer|grader) is (wrong|broken|biased|lying)\b|\bthat'?s not a (real|valid) (test|eval|measurement)\b/i],
];
// Corrections that name no category: investigated by /flow:learn, which is how new categories are found.
const IMPLICIT = /^\W*(no[,.!]\s|nope\b|wrong\b|that'?s (wrong|incorrect|not right)|revert (that|this|it)\b|undo (that|this)\b|that broke|you broke|this is broken)/i;
const PREFERENCE = /\b(i (prefer|like|'d rather|would rather)|please (always|use)|from now on,? (use|write|call)|my style|personally)\b/i;
const REQUIREMENT_CHANGE = /\b(actually,? (let'?s|we|use|i want)|change of plans?|new requirement|instead,? (let'?s|we|use)|let'?s (switch|go with|use) .+ instead|scratch that|the (client|customer|pm|spec) (now )?(wants|changed))\b/i;
const POSITIVE = /^\W*(perfect|exactly( what i (wanted|needed))?|great job|nice work|well done|love it|clean (implementation|solution)|good,? concise|looks great|ship it|lgtm)\b|\b(exactly what i wanted|this is perfect|good,? concise,? and (well[- ])?tested)\b/i;
const SARCASM = /\b(lol|lmao|haha|\/s)\b|\b(great|perfect|wonderful|awesome),? (another|more) (meeting|outage|day|week|bug from)\b|\b(ugh|sigh),? (mondays?|jira|meetings|traffic|the build server)\b/i;
// Text that did not come from the engineer typing: harness notices, teammates, continuations.
const AUTOMATED = /<(system-reminder|task-notification|command-name|local-command-stdout|teammate-message)\b|^\s*\[SYSTEM NOTIFICATION|^\s*Caveat: The messages below were generated|^\s*This session is being continued from a previous conversation|^\s*\[Request interrupted/i;

/** Classify one engineer prompt. Returns null for anything that is not feedback. */
export function classifyPrompt(text) {
  const prompt = String(text ?? "");
  if (!prompt.trim() || AUTOMATED.test(prompt)) return null;
  const head = prompt.slice(0, 1200);
  const hits = CORRECTIONS.filter(([, , re]) => re.test(head));
  if (!hits.length && SARCASM.test(head)) return { kind: "noise", reason: "sarcasm or venting, not about the agent's work" };
  if (hits.length) {
    const [category] = hits[0];
    const keys = [...new Set(hits.filter(([c]) => c === category).map(([, k]) => k))].sort();
    const preference = category === "communication" || (PREFERENCE.test(head) && hits.every(([c]) => c === "communication"));
    return { kind: preference ? "preference" : "correction", category, keys };
  }
  if (REQUIREMENT_CHANGE.test(head)) return { kind: "requirement-change", reason: "the goal changed; not an agent failure" };
  if (POSITIVE.test(head) && !/\b(not|n't|never|but)\b/i.test(head.slice(0, 80))) return { kind: "positive" };
  if (IMPLICIT.test(head)) return { kind: "correction", category: "unclassified", keys: ["implicit"] };
  if (PREFERENCE.test(head)) return { kind: "preference", category: "communication", keys: ["preference"] };
  return null;
}
export const isAutomated = (text) => AUTOMATED.test(String(text ?? ""));

// ---------- constraints the engineer states ----------

/** Which constraint rules a prompt starts or releases (rules from hooks/constraint-rules.json). */
export function constraintChanges(text, rules) {
  const prompt = String(text ?? "");
  if (!prompt.trim() || AUTOMATED.test(prompt)) return { start: [], release: [] };
  const start = [], release = [];
  // A prohibition wins over a permission in the same prompt ("don't merge until I say you can merge").
  for (const rule of rules ?? []) {
    if ((rule.phrases ?? []).some((p) => new RegExp(p, "i").test(prompt))) start.push(rule.id);
    else if ((rule.release ?? []).some((p) => new RegExp(p, "i").test(prompt))) release.push(rule.id);
  }
  return { start, release };
}

/** Does a Bash command fall under an active constraint rule? Returns the rule, or null. */
export function violatedConstraint(command, rules, active) {
  const cmd = String(command ?? "").replace(/\\\n/g, " ");
  for (const rule of rules ?? []) {
    if (!active.includes(rule.id)) continue;
    if ((rule.allow ?? []).some((p) => new RegExp(p, "i").test(cmd))) continue;
    if ((rule.blocks ?? []).some((p) => new RegExp(p, "i").test(cmd))) return rule;
  }
  return null;
}

// ---------- transcript signals (session end) ----------

const TEST_COMMAND = /\b(npm (run )?test|pnpm (run )?test|yarn test|bun test|vitest|jest|pytest|go test|cargo test|node --test|mocha|rspec|phpunit|dotnet test|mvn test|gradle test)\b/;
const COMPLETION_CLAIM = /\b(all (tests )?(pass|passing|green)|it'?s (done|fixed|working)|(is|are) now (done|fixed|working)|i'?ve (fixed|finished|completed)|task (is )?complete|everything (works|is working))\b/i;
export const isTestCommand = (command) => TEST_COMMAND.test(String(command ?? ""));
export const claimsCompletion = (text) => COMPLETION_CLAIM.test(String(text ?? ""));

/**
 * Behavioral signals from a transcript's records (already parsed JSON lines). Counts only, never text.
 * Tool results pair with tool uses by id; a test command whose result is an error counts as a failing run.
 */
export function transcriptSignals(records) {
  const uses = new Map();
  let streak = 0, maxStreak = 0, lastEdit = -1, lastTest = -1, i = 0, lastAssistantText = "";
  const commands = new Map(), edits = new Map();
  for (const record of records) {
    i++;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (record.type === "assistant" && item.type === "tool_use") {
        uses.set(item.id, item);
        const input = item.input ?? {};
        if (item.name === "Bash" && typeof input.command === "string") {
          const key = input.command.trim();
          commands.set(key, (commands.get(key) ?? 0) + 1);
        }
        if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(item.name)) {
          const file = String(input.file_path ?? input.notebook_path ?? "");
          edits.set(file, (edits.get(file) ?? 0) + 1);
          lastEdit = i;
        }
      } else if (record.type === "assistant" && item.type === "text") lastAssistantText = item.text ?? "";
      else if (record.type === "user" && item.type === "tool_result") {
        const use = uses.get(item.tool_use_id);
        if (use?.name === "Bash" && isTestCommand(use.input?.command)) {
          lastTest = i;
          if (item.is_error) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
        }
      }
    }
  }
  return {
    failingTestStreak: maxStreak,
    repeatedCommand: Math.max(0, ...commands.values()),
    maxEditsOneFile: Math.max(0, ...edits.values()),
    unverifiedCompletion: claimsCompletion(lastAssistantText) && lastEdit > lastTest,
    toolCalls: uses.size,
  };
}

/** Thresholds at which a session signal is an objective incident. */
export function signalIncidents(signals) {
  const out = [];
  if (signals.failingTestStreak >= 3) out.push({ category: "verification", keys: ["failing-test-streak"] });
  if (signals.unverifiedCompletion) out.push({ category: "verification", keys: ["unverified-claim"] });
  if (signals.repeatedCommand >= 4) out.push({ category: "tool-inefficiency", keys: ["repeated-command"] });
  if (signals.maxEditsOneFile >= 10) out.push({ category: "tool-inefficiency", keys: ["rewrites"] });
  return out;
}
