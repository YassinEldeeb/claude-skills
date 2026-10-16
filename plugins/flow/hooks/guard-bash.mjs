// PreToolUse (Bash), best effort: an agent never authorizes itself. In a flow repo it refuses commands that post or sign
// approvals, write approval records, merge with --admin, or change branch protection. Fails open; GitHub settings are the hard part.
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
  if (!command || !loadFlow(repoRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()))) process.exit(0);
  for (const [pattern, what] of RULES) {
    if (pattern.test(command)) block(`Refused: ${what}. Approvals, merges past the gate and repository protection belong to humans; ask the human, with the exact line they need.`);
  }
  if (/\.flow\/tasks\/\S*\.approved\b/.test(command) && !READ_ONLY.test(command)) block("Refused: writing an approval record. Only `node .github/flow/flow.mjs sync <ID>` records an approval a human gave on the PR.");
  if (/\bgh\s+api\b/.test(command) && PROTECTION.test(command) && writesApi(command)) block("Refused: changing branch protection, rulesets, environments or Actions permissions. Recommend the change to the human instead.");
  process.exit(0);
} catch {
  process.exit(0);
}
