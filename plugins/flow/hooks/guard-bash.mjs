// PreToolUse (Bash), best effort: an agent never authorizes itself. In a flow repo it refuses commands that post or sign
// approvals, write approval records, merge with --admin, or change branch protection. Fails open; GitHub settings are the hard part.
import { violatedConstraint } from "../learn/classify.mjs";
import { home, loadSession } from "../learn/store.mjs";
import { activeConstraints, constraintRules } from "./capture.mjs";
import { loadFlow, readInput, repoRoot, block } from "./common.mjs";

const RULES = [
  [/\b(gh|curl|wget|hub)\b[\s\S]*\/flow\s+approve\b/, "posting a /flow approval"],
  [/\bflow\.mjs["']?\s+approve\b/, "signing a /flow approval"],
  [/\bssh-keygen\b[\s\S]*-Y\s*sign\b/, "creating an SSH signature"],
  [/\bgh\b[\s\S]*\bpr\s+merge\b[\s\S]*--admin\b/, "merging with --admin (it bypasses the required flow check)"],
];
const PROTECTION = /(branches\/[^\s/]+\/protection|\/rulesets\b|\/environments\b|actions\/permissions)/;
// gh api sends POST when it has fields or input and no explicit method.
const writesApi = (cmd) => {
  const method = /(?:-X|--method)[=\s]*['"]?([A-Za-z]+)/.exec(cmd)?.[1]?.toUpperCase();
  return method ? method !== "GET" : /(--input|--field|--raw-field|\s-[fF]\s)/.test(cmd);
};
const READ_ONLY = /^\s*(cat|less|head|tail|ls|stat|wc|git\s+(diff|status|log|show))\b[^;&|>`$]*$/;

try {
  const input = await readInput();
  const command = (input.tool_input?.command ?? "").replace(/\\\n/g, " ");
  if (!command) process.exit(0);
  // flow's local feedback store and its controls belong to the engineer (any repo; best effort).
  const lower = command.toLowerCase();
  const store = home().replace(/^\/Users\/[^/]+/, "~").toLowerCase();
  const reading = /^\s*(cat|less|head|tail|ls|stat|wc|grep|rg)\b[^;&|>`$]*$/.test(command);
  if ((lower.includes(".claude/flow-feedback") || lower.includes(store)) && !reading) block("Refused: changing flow's local feedback store. It is the engineer's record; only its CLI, run by the engineer, changes it.");
  if (/\blearn\b/i.test(command) && /\bcli\.mjs["']?\s+(disable|enable|delete|auto\s+(on|off))\b/i.test(command)) block("Refused: flow-learn disable, enable, delete and auto on/off are the engineer's controls; tell them the command instead.");
  // Eval spend only with the engineer's approval this session ("approve spend up to $20"), recorded by the prompt hook.
  if (/--approve-spend\b/.test(command)) {
    const approved = loadSession(input.session_id).spendApprovedUsd;
    const budget = Number(/--budget-usd[=\s]+([\d.]+)/.exec(command)?.[1]);
    if (!(approved > 0) || !(budget <= approved)) block(`Refused: model-eval spend needs the engineer's approval in this session (approved: ${approved ? `$${approved}` : "none"}). Ask them, with the estimate.`);
  }
  if (loadFlow(repoRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()))) {
    for (const [pattern, what] of RULES) {
      if (pattern.test(command)) block(`Refused: ${what}. Approvals, merges past the gate and repository protection belong to humans; ask the human, with the exact line they need.`);
    }
    if (/\.flow\/tasks\/\S*\.approved\b/.test(command) && !READ_ONLY.test(command)) block("Refused: writing an approval record. Only `node .github/flow/flow.mjs sync <ID>` records an approval a human gave on the PR.");
    if (/\bgh\s+api\b/.test(command) && PROTECTION.test(command) && writesApi(command)) block("Refused: changing branch protection, rulesets, environments or Actions permissions. Recommend the change to the human instead.");
  }
  // Constraints the engineer stated this session ("don't merge"), in any repo. Last and on their own: a broken rule
  // can never disable the checks above. Best effort: GitHub's required checks are the hard layer.
  try {
    const rule = violatedConstraint(command, constraintRules(), activeConstraints(input.session_id));
    if (rule) block(`Refused: the engineer said this session: ${rule.why}. Ask them; only their own prompt lifts it.`);
  } catch { /* fail open for this check only */ }
  process.exit(0);
} catch {
  process.exit(0);
}
