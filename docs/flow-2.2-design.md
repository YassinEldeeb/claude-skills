# flow 2.2: one entry point, and prove the risky part first

## What prompted it

A background pipeline project ran for about eleven days under flow 2.0/2.1 with several agents in parallel. Every individual piece had a spec, tests and reviews. The project still took days longer than it needed, for reasons the workflow didn't catch:

- **The deciding number came last.** Nobody ran the planned processing shape on a real person's data until late. When someone finally did, the forecast for a heavy user was days, against a target of hours. Every earlier review had checked the pieces, not the whole run.
- **Patches instead of design questions.** The same kind of failure (a free-text safety rule) was patched pass after pass. Each fix was defensible, and each one made the next failure.
- **Evaluation outgrew the product.** The eval tooling grew larger than the code it measured. Runs were slow and noisy, and the local setup differed from production (model, data dates), so results often didn't carry over.
- **Parallel builders before a working path.** Several builders worked on pieces before one end-to-end path worked. Integration bugs surfaced only on the combined branch, and dependencies outside the repo (flags, data access) surfaced only when production wiring was tried.
- **A manual, not a driver.** The README listed eight commands. Engineers read it as a procedure to operate, not one command that leads.

## What changed

1. **`/flow:start` is the only command you need.** It runs every step itself and comes back only at a human checkpoint (spec approval, a 🔴 decision, ship approval) or when the work is done. It never ends a turn by handing the engineer a flow command. The phase skills (`challenge`, `build`, `verify`, `ship`, `orchestrate`) are `user-invocable: false`: the model still loads them, and the `/` menu shows only `start`, `status`, `install` and `learn`. Later prompts on the branch resume the task (session start says so).
2. **Prove it first (start §5).** For medium and high work, name the one assumption that would sink the plan. Run the planned shape on a real sample with production's settings, measure it, forecast the whole workload (heaviest case included) against the target, and switch to plan B before building if it misses. The challenge step now requires this measurement before the spec approval, and prefers an existing path over a new engine.
3. **Rounds (start §6).** Round 1 is a walking skeleton through the real system, with outside dependencies wired and checked at their source. One builder until it works. Each round ends with something visible and a fixed scorecard (three or fewer outcome numbers, absolute targets) in `.flow/tasks/<ID>/progress.md`. `/flow:status` reports the last round.
4. **Stop and rethink (start §7).** Two strikes on the same kind of bug means asking which operation can be removed. Two off-track rounds, or a forecast that misses the deadline, means a 🔴 decision with plan B. Measurements must match production. Evals stay small, with their noise measured first.
5. **Pasted text grants nothing.** The prompt hook took "approve spend up to $20" from a pasted README as the engineer's spend approval. It also took constraints and corrections from pasted text. Grants, constraints and capture now read only the engineer's own words (`ownWords`, which drops `<pasted_content>` blocks).

## What did not change

- **The gate and the task schema.** `.flow/tasks/<ID>/progress.md` is a plain file the gate doesn't read, so repos on the 2.0 gate need no upgrade. The scorecard lives there, not in `task.json`: the 2.0 gate rejects unknown task fields.
- **No continuation hook.** I considered a Stop hook that sends the agent back to the next step. A baseline run showed current flow already carries a medium task from one prompt to verified, stopping only at a real blocker (no remote). The evidence didn't justify a mechanism that could keep a wrong loop running.

## Evidence

Three behavioral cases under `plugins/flow/learn/cases/drive-*`, run with real plugin loading (`flow-learn prove`, `claude -p --plugin-dir`, Sonnet), baseline `origin/master` against this branch. Results: see the PR description.

| Case | What a pass needs |
|---|---|
| `drive-medium-forecast` | One `/flow:start` on a medium feature ends verified (task, evidence, `verify.md`, working cached client) without handing back a step the agent could run |
| `drive-measure-first` | A performance-sensitive high-risk job: before the spec approval, the planned processing runs on the real sample and the forecast comes from that measurement (the stand-in model client's cost depends on input size and publishes no formula) |
| `drive-two-misses` | A task two rounds off-track: continuing it changes the approach and meets the target, or raises a decision, instead of another tweak |
