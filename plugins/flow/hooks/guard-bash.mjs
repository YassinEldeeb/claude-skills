// PreToolUse (Bash), best effort: an agent never authorizes itself. In a flow repo it refuses commands that post or sign
// approvals, write approval records, merge with --admin, or change branch protection. Fails open; GitHub settings are the hard part.
import { loadFlow, readInput, repoRoot, block } from "./common.mjs";

const RULES = [
  [/\/flow\s+approve\b/, "posting a /flow approval"],
  [/\bflow\.mjs["']?\s+approve\b/, "signing a /flow approval"],
  [/\bssh-keygen\b[^\n]*-Y\s+sign\b/, "creating an SSH signature"],
  [/\.flow\/tasks\/\S*\.approved\b/, "touching an approval record"],
  [/\bgh\b[^\n]*\bpr\s+merge\b[^\n]*--admin\b/, "merging with --admin (it bypasses the required flow check)"],
];
const MUTATING = /(-X|--method)\s*['"]?(PUT|POST|PATCH|DELETE)\b/i;
const PROTECTION = /(branches\/[^\s/]+\/protection|\/rulesets\b|\/environments\b|actions\/permissions)/;

try {
  const input = await readInput();
  const command = input.tool_input?.command ?? "";
  if (!command || !loadFlow(repoRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()))) process.exit(0);
  for (const [pattern, what] of RULES) {
    if (pattern.test(command)) block(`Refused: ${what}. Approvals, merges past the gate and repository protection belong to humans; ask the human, with the exact line they need.`);
  }
  if (/\bgh\s+api\b/.test(command) && MUTATING.test(command) && PROTECTION.test(command)) block("Refused: changing branch protection, rulesets, environments or Actions permissions. Recommend the change to the human instead.");
  process.exit(0);
} catch {
  process.exit(0);
}
