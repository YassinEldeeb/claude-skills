---
name: ship
description: Open the PR with evidence, get the flow gate and CI green, merge, deploy through the normal pipeline and verify the result live. Use for /flow:ship.
---

# Ship

1. **The PR body:**
   - a `Flow-Task: <ID>` line (several ids if the PR carries several tasks), or no line plus a `## Evidence` section for a small change;
   - what changed;
   - an evidence summary for humans.
   Set `pr` in `task.json`.
2. **See what the gate will say** before asking anyone: `node .github/flow/flow.mjs check --pr <N>`. Fix every blocker you can.
3. **Watch CI, the gate and any review bot** until done. Use a cheaper model or a background wait for the watching. Fix clear findings yourself.
   - The gate re-runs on every push, when the CI workflows named in its `workflow_run` trigger finish, and on any comment containing `/flow`.
   - If CI or a review bot finished and the `flow` check still shows the old result, comment `/flow` to re-run it.
4. **High risk, checkpoint 3:** when everything else is green, the gate posts the `ship@` line for these exact changes. Ask the human with that line and one screen:
   - what works, with evidence;
   - what's unknown;
   - what's being authorized.
   In signed mode they run `node .github/flow/flow.mjs approve "<line>" --pr <N>` on their machine. Never post or sign an approval yourself.
5. **Merge** only when the `flow` check is green. Never use `--admin` and never bypass protection. Use auto-merge only if the human authorized it for this kind of change.
6. **Deploy** through the repo's normal pipeline, never by hand. Prove the release contains the change: a deployment record, the serving sha, or a deploy tag. A merge is not a deploy.
7. **Verify live:** run the canary criteria and record their evidence. Before widening a rollout, run `node .github/flow/flow.mjs rollout-ok --pr <N>`. It refuses while an assumption marked `blocks: rollout` is unverified.
8. **Watch** errors and metrics after the deploy. If things are worse, propose a rollback and wait, unless the human pre-authorized one.

Report in 3 lines, as outcomes: what's built, tested, integrated, merged, deployed and verified (with proof); what's waiting on whom; what's next.
