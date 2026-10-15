// PreToolUse (Bash), best effort: refuse PR merges while a 🔴 decision is unsettled or the design drifted without approval.
// Fails open: if this script crashes, the command runs. CI is the hard gate.
import { readFile, unapprovedChanges, unsettledRedDecisions } from "../templates/github/flow-lib.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
let command = "";
try { command = JSON.parse(input)?.tool_input?.command ?? ""; } catch { process.exit(0); }
const merges = /(^|[;&|]\s*)gh\s+(-R\s+\S+\s+|--repo\s+\S+\s+)?pr\s+merge\b/m.test(command)
  || /\bgh\s+api\b[^\n]*\/pulls\/\d+\/merge\b/.test(command);
if (!merges) process.exit(0);

const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const reds = unsettledRedDecisions(readFile(dir, "decisions.md"));
const drift = unapprovedChanges(readFile(dir, "status.md"));
if (!reds.length && !drift.length) process.exit(0);

const why = [
  reds.length ? `unsettled 🔴 decisions in decisions.md: ${reds.join("; ")}` : null,
  drift.length ? `unapproved changes in status.md: ${drift.join("; ")}` : null,
].filter(Boolean).join(" · ");
process.stderr.write(`[flow] Merge blocked: ${why}. Ask the human. Only record an approval the human gave you in this session; never approve it yourself.\n`);
process.exit(2);
