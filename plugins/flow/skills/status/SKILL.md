---
name: status
description: Report where flow tasks really stand - built, tested, integrated, merged, deployed, verified, authorized - with blockers and unknowns, from the gate's own evaluation. Use for /flow:status, or whenever someone asks "is it ready?".
---

# Status

1. Run `node .github/flow/flow.mjs status`, or `status <ID>` for one task. For a task with a PR it runs the same evaluation as the CI gate. Without a PR it checks the task file offline.
2. Report each task in one block:
   - the stage line (built → tested → integrated → merged → deployed → authorized);
   - the blockers, each with who unblocks it;
   - the unknowns;
   - the last round in `.flow/tasks/<ID>/progress.md`: its scorecard, forecast and verdict. Two off-track rounds in a row is a blocker for the human, with plan B.
   Copy the gate's words; don't soften them.
3. Rules:
   - **Unknown is not pass.** Say "unknown", and what would settle it.
   - **Merged is not done.** Done means deployed, and the canary criteria verified in the deployed system.
   - Numbers come with their source, model and date.
   - Never report activity (tests written, commits, lines) as progress.
4. When several tasks depend on each other, add one line for the release:
   - what has to merge, in which order;
   - which paired deploys are pending;
   - the combined-system test that proves them together.
