// The three demo improvements, as /flow:learn produced them: written after the independent cases existed, each the
// smallest edit to one allowed file. Applied to a copy of the plugin to build the candidate tree.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// v2: v1 passed 51/51 on fixtures its author had seen and 43/62 on the first unseen held-out set (rejected); v2 is
// written against that set (now development data) and judged on a second unseen set.
export const NO_MERGE_RULE = {
  id: "no-merge",
  why: "no merging pull requests until the engineer says so",
  covers: ["merge"],
  phrases: [
    "\\b(don'?t|do not|never|no)\\b[^.?!\\n]{0,40}\\bmerg(e|es|ing)\\b",
    "\\b(wait|hold off)\\b[^.?!\\n]{0,25}\\bmerg(e|es|ing)\\b",
    "\\bmerg(e|es|ing) (is|are) off the table\\b",
    "\\b(leave|keep)\\b[^.?!\\n]{0,25}\\bunmerged\\b",
  ],
  release: [
    "\\b(you can|you may|go ahead and|feel free to|ok(ay)? to|please) merge\\b",
    "\\bmerge (it|the pr) now\\b",
    "\\bmerge away\\b",
    "\\bmerge when (ci is |it'?s |it is )?green\\b",
  ],
  // Read-only commands that only print text mentioning a merge (no pipe or chaining into something that could run it).
  allow: [
    "^\\s*(grep|rg|ag|echo|printf|cat|less|head|tail|man)\\b[^|;&`$]*$",
    "\\bgh\\b[^|;&]*\\bpr\\s+merge\\b[^|;&]*\\s(--help|-h)\\b[^|;&]*$",
  ],
  blocks: [
    "\\bgh['\"]?\\s+(?:(?:-R|--repo)[=\\s]+\\S+\\s+)*['\"]?pr['\"]?\\s+(?:(?:-R|--repo)[=\\s]+\\S+\\s+)*['\"]?merge\\b",
    "\\bgh\\s+alias\\s+set\\b[\\s\\S]*\\bpr\\s+merge\\b",
    "(-X|--method|--request|-[a-zA-Z]+X)[\\s=]*['\"]?put\\b[\\s\\S]*/pulls/\\d+/merge\\b",
    "\\b(mergePullRequest|enablePullRequestAutoMerge)\\b",
    "\\bput\\b[\\s\\S]*/pulls/\\d+/merge\\b",
    "/pulls/\\d+/merge\\b[\\s\\S]*\\bput\\b",
    "\\bgraphql\\b[\\s\\S]*@\\S*merge",
    "\\bhub\\s+merge\\b",
    "\\bgit\\b[\\s\\S]*\\bpush\\b[\\s\\S]*[\\s:](refs/heads/)?(main|master)\\b(?!-)",
  ],
};

const replaceOnce = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error(`anchor not found exactly once: ${from.slice(0, 60)}`);
  return text.replace(from, to);
};

export const CANDIDATES = {
  "unauthorized-action--merge": {
    rootCause: "Nothing enforced the engineer's 'don't merge': flow's constraint engine had no rule for merges, and an instruction can't stop an action the agent decides is fine. Mechanical failure, so deterministic enforcement.",
    change: "Add the no-merge constraint rule (data only, plugins/flow/hooks/constraint-rules.json): an engineer's 'don't merge' starts it, 'you can merge' lifts it, and while active the Bash guard refuses gh pr merge (any form), GraphQL merge mutations and REST merge PUTs. Best effort; GitHub's required checks remain the hard layer.",
    apply(tree) {
      const file = join(tree, "plugins/flow/hooks/constraint-rules.json");
      const rules = JSON.parse(readFileSync(file, "utf8"));
      rules.rules = [...rules.rules.filter((r) => r.id !== "no-merge"), NO_MERGE_RULE];
      writeFileSync(file, `${JSON.stringify(rules, null, 2)}\n`);
      const caseFile = join(tree, "plugins/flow/learn/cases/no-merge-constraint/case.json");
      const testCase = JSON.parse(readFileSync(caseFile, "utf8"));
      writeFileSync(caseFile, `${JSON.stringify({ ...testCase, enforced: true }, null, 2)}\n`);
    },
  },
  "outcome-drift--proxy-data": {
    rootCause: "/flow:start step 1 says to read 'the data' but never asks which source is authoritative or what to do when a convenient one differs, so a proxy (all sign-ups) passes as the answer without a word.",
    change: "Replace /flow:start step 1 with 'the deliverable and its source': name the exact deliverable and the authoritative source as the repo defines it, and disclose and ask before using anything else.",
    apply(tree) {
      const file = join(tree, "plugins/flow/skills/start/SKILL.md");
      writeFileSync(file, replaceOnce(readFileSync(file, "utf8"),
        "## 1. Evidence first\n\nRead the relevant code, recent PRs, logs and data. For a bug, find the first cause and whether it's a regression (when, which PR). Small work: minutes, not hours.",
        "## 1. Evidence first: the deliverable and its source\n\nName the deliverable (the exact number, file or behavior asked for) and the authoritative source it must come from, as the repo defines it (look for a metrics or glossary doc). Using anything else (a convenient export, a sample, a guess) needs saying in the answer and asking first; never substitute silently. For a bug, find the first cause and whether it's a regression (when, which PR). Small work: minutes, not hours."));
    },
  },
  "overengineering--overengineering": {
    rootCause: "flow asks for the simplest option in /flow:challenge, but small work never reaches /flow:challenge: the small route in /flow:start says only 'fix', so nothing pushes back on new files, layers or dependencies.",
    change: "Tighten the small route in /flow:start's routing table: the smallest diff that works, with no new files, layers or dependencies the task doesn't need.",
    apply(tree) {
      const file = join(tree, "plugins/flow/skills/start/SKILL.md");
      writeFileSync(file, replaceOnce(readFileSync(file, "utf8"),
        "| Small | Reproduce → fix → test → PR with a `## Evidence` section. No task. | None |",
        "| Small | Reproduce → the smallest diff that works (no new files, layers or dependencies the task doesn't need) → test → PR with a `## Evidence` section. No task. | None |"));
    },
  },
};
