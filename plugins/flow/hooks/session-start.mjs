// SessionStart: put the repo's status, unsettled 🔴 decisions and unapproved drift into the agent's context.
import { readFile, unapprovedChanges, unsettledRedDecisions } from "../templates/github/flow-lib.mjs";

const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const status = readFile(dir, "status.md");
if (status === null) process.exit(0); // repo not set up for flow: stay silent

const reds = unsettledRedDecisions(readFile(dir, "decisions.md"));
const drift = unapprovedChanges(status);
const lines = ["[flow] This repo uses the flow workflow (CLAUDE.md / AGENTS.md). Current status.md:", status.trim()];
if (reds.length) lines.push(`[flow] Unsettled 🔴 decisions (need a human): ${reds.join("; ")}`);
if (drift.length) lines.push(`[flow] Unapproved changes from the approved design: ${drift.join("; ")}. Stop and ask before building on them.`);
process.stdout.write(lines.join("\n") + "\n");
