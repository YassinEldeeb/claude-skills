---
name: orchestrate
description: Optional unattended mode. Coordinate several builder sessions on dependent tasks for hours, without coding yourself, and integrate their work into one verified release. Use for /flow:orchestrate when work splits into several tasks.
---

# Orchestrate

You coordinate; you never code. **Parallelize implementation, not unresolved architecture.**

1. **Contracts first.** Before any split, one task fixes the shared interfaces and invariants: schemas, file formats, API shapes, ordering and fencing rules. It merges first; everything else `dependsOn` it.
2. **Plan the integration:**
   - the dependency graph (`integration.dependsOn` in each task, cross-repo as `owner/repo#N`);
   - one integration owner;
   - the merge order;
   - the paired deploy plan (`integration.deployPlan`);
   - the combined-system test that proves the pieces together (`evidence.integration`).
   The gate refuses a task whose dependencies haven't merged.
3. **Builders:** one per task, each in its own worktree, with its own PR, goal and criteria. Use few of them (3–5), and a cheaper model for chores (watching CI, deploy checks, small reviews).
4. **Watchdog:** a real timer (background wait or scheduled wakeup) checks every builder and PR about every 15 minutes. Look for stalled *jobs*, not just idle agents:
   - a hung command;
   - CI waiting on nothing;
   - a builder waiting on a human;
   - a builder repeating the same investigation without new evidence (stop it and escalate the assumption).
5. **Unblock:**
   - answer 🟢 and 🟡 calls with defaults, and record them in the task `log`;
   - batch 🔴 calls for the human, each with a recommendation;
   - never approve anything, post an approval, merge past the gate or enable auto-merge without the human's explicit say-so.
6. **Durable state** lives in the task files and PRs, so a disconnect or a usage limit loses nothing. Resume builders from `flow.mjs status`.
7. **Re-integrate on change.** When a dependency's spec changes after others built on it, their integration evidence is stale: re-run the combined test before calling anything ready.

Report each check-in in 3 lines, from `/flow:status`:
- what is verified, and where;
- what's blocked, on whom;
- the one thing the human should do next.
