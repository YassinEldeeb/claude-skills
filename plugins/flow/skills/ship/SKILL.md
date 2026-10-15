---
name: ship
description: Step 5 of flow. Open the PR with evidence, get CI and review green, merge, deploy and verify live. Use for /flow:ship.
---

# Ship

1. **PR body** fills the template: acceptance criteria with evidence · deviations and who approved them · "Needs a human because" (or "none").
2. **CI + review bot:** watch both until done, using a cheaper model (Sonnet) subagent for the watching; fix clear findings yourself.
3. **Merge:** only with green CI, a clean review and no open 🔴 (the flow hook and CI block it otherwise). Auto-merge only if the human explicitly authorized it for this kind of change.
4. **Deploy and verify:** deploy only through the repo's normal pipeline, never by hand or forced. Confirm the release actually contains the change, run a live check or canary, and update `status.md` Deployed (where: staging or production).
5. **Watch:** check the outcome (errors, metrics) after deploy. If it's worse, propose a rollback and wait for the human, unless they pre-authorized one.

Report in 3 lines: what's live (with proof) · what's waiting on whom · what's next.
