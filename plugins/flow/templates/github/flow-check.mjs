// flow CI check: fails while a 🔴 decision is unsettled, the design drifted without approval,
// or the PR body leaves the template empty / asks for a human without the `human-approved` label.
import { readFile, unapprovedChanges, unsettledRedDecisions } from "./lib.mjs";

const failures = [];
const decisions = readFile(".", "decisions.md");
const status = readFile(".", "status.md");
if (decisions === null || status === null) console.warn("flow: decisions.md or status.md is missing; their checks are skipped");
for (const item of unsettledRedDecisions(decisions)) failures.push(`unsettled 🔴 decision: ${item}`);
for (const item of unapprovedChanges(status)) failures.push(`unapproved change in status.md: ${item}`);

// PR body checks only on real pull requests by people (not merge queues, not bots).
const event = process.env.EVENT_NAME ?? "pull_request";
const actor = process.env.ACTOR ?? "";
if (event === "pull_request" && !actor.endsWith("[bot]")) {
  const body = (process.env.PR_BODY ?? "").replace(/\r\n?/g, "\n");
  const labels = (process.env.PR_LABELS ?? "").split(",").map((label) => label.trim());
  const section = (title) => {
    const match = body.match(new RegExp(`##\\s*${title}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i"));
    return match ? match[1].replace(/<!--[\s\S]*?-->/g, "").trim() : null;
  };
  for (const title of ["Acceptance criteria", "Deviations", "Needs a human"]) {
    const text = section(title);
    if (!text) failures.push(`PR body: "${title}" section is missing or empty`);
  }
  const human = section("Needs a human");
  const nothing = /^[-*\s]*(none|n\/a|no|nothing)\b/i;
  if (human && !nothing.test(human) && !labels.includes("human-approved")) {
    failures.push('PR asks for a human: a reviewer adds the "human-approved" label after reviewing it');
  }
}

if (failures.length) {
  console.error("flow check failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("flow check passed");
