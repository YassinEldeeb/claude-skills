# flow 2.2: one entry point, and prove the risky part first

## What prompted it

A background pipeline project ran for about eleven days with several agents in parallel. Every individual piece had a spec, tests and reviews. The project still took days longer than it needed, for reasons the workflow didn't catch:

- **The deciding number came last.** Nobody ran the planned processing shape on a real person's data until late. When someone finally did, the forecast for a heavy user was days, against a target of hours. Every earlier review had checked the pieces, not the whole run.
- **Patches instead of design questions.** The same kind of failure (a free-text safety rule) was patched pass after pass. Each fix was defensible, and each one made the next failure.
- **Evaluation outgrew the product.** The eval tooling grew larger than the code it measured. Runs were slow and noisy, and the local setup differed from production (model, data dates), so results often didn't carry over.
- **Parallel builders before a working path.** Several builders worked on pieces before one end-to-end path worked. Integration bugs surfaced only on the combined branch, and dependencies outside the repo (flags, data access) surfaced only when production wiring was tried.
- **A manual, not a driver.** The README listed eight commands. Engineers read it as a procedure to operate, not one command that leads.

## What changed

1. **`/flow:start` is the only command you need.** It runs every step itself and comes back only at a human checkpoint (spec approval, a 🔴 decision, ship approval) or when the work is done. It never ends a turn by handing the engineer a flow command, except an approval, which only a human gives. The phase skills (`challenge`, `build`, `verify`, `ship`, `orchestrate`) are `user-invocable: false`: the model still loads them, and the `/` menu shows only `start`, `status`, `install` and `learn`. Later prompts on the branch resume the task (session start says so).
2. **Prove it first (start §5).** For medium and high work, name the one assumption that would sink the plan. Run the planned shape on a real sample with production's settings, measure it, forecast the whole workload (heaviest case included) against the target, and switch to plan B before building if it misses. The challenge step now requires this measurement before the spec approval, and prefers an existing path over a new engine.
3. **Rounds (start §6).** Round 1 is a walking skeleton through the real system, with outside dependencies wired and checked at their source. One builder until it works. Each round ends with something visible and a fixed scorecard (three or fewer outcome numbers, absolute targets) in `.flow/tasks/<ID>/progress.md`. `/flow:status` reports the last round.
4. **Stop and rethink (start §7).** Two strikes on the same kind of bug means asking which operation can be removed. Two off-track rounds, or a forecast that misses the deadline, means a 🔴 decision with plan B. Measurements must match production. Evals stay small, with their noise measured first.
5. **Pasted text grants nothing.** The prompt hook took "approve spend up to $20" from a pasted README as the engineer's spend approval. It also took constraints and corrections from pasted text. Grants, constraints and capture now read only the engineer's own words (`ownWords`, which drops `<pasted_content>` blocks).

## What did not change

- **The gate and the task schema.** `.flow/tasks/<ID>/progress.md` is a plain file the gate doesn't read, so repos on the 2.0 gate need no upgrade. The scorecard lives there, not in `task.json`: the 2.0 gate rejects unknown task fields.
- **No continuation hook.** I considered a Stop hook that sends the agent back to the next step. A baseline run showed current flow already carries a medium task from one prompt to verified, stopping only at a real blocker (no remote). The evidence didn't justify a mechanism that could keep a wrong loop running. Continuation stays an instruction, with its exits written down: the engineer says stop or asks something else, a checkpoint, a named wait, or done.

## Evidence (2026-10-19, Sonnet, real plugin loading)

Three behavioral cases under `plugins/flow/learn/cases/drive-*`, run with `flow-learn prove` (`claude -p --plugin-dir`), baseline `origin/master` against this branch, one run per prompt per arm, three rounds. The existing suite (`outcome-drift-paying-customers`, `overengineering-health-endpoint`, the no-merge cases) is run alongside each round.

| Case | What a pass needs | Result |
|---|---|---|
| `drive-measure-first` | A performance-sensitive high-risk job (a nightly model pass over every user's notes, 1-hour target). Before the spec approval, the planned processing runs on the real sample and the forecast comes from it. The stand-in client's cost depends on input size and publishes no formula. | **Ran the planned shape on the sample before deciding: this branch 5 of 8 runs, master 1 of 9** (counted from the transcripts). Master read the client's code and estimated, and twice labelled such a number "measured". Both arms usually saw that the plan misses the hour. The scorer missed real runs twice, when the agent tidied its spike output, so the gated verdict stayed inconclusive. The case now also records usage under `.git/`. |
| `drive-medium-forecast` | One prompt on a medium feature ends verified (task, evidence, `verify.md`, a working cached client) without handing back a step the agent could run | **No improvement shown.** Master already does this most of the time (5 of 8). This branch passed 3 of 6 after the fix below. In the failures, one run misread the README and sized the task small, and two plain-language prompts stopped before `verify.md`. |
| `drive-two-misses` | A task two rounds off-track: continuing changes the approach and meets the target, or raises a decision | **Cannot reproduce:** master passed every run (it switched to batch inserts), so no improvement can be shown. |
| Existing suite | No regressions | Same on both arms in every round (behavioral 3/3 each; deterministic cases identical). |

What the rounds changed. Round 1 showed this branch folding build and verify into one step on a medium task, with no evidence and no `verify.md`. The route table now names `/flow:build`, `/flow:verify` and `/flow:ship` as skills to load and finish, and says what "done" means for medium work. A fresh-eyes review then found that medium tasks skipped the light challenge the gate requires, that the forecast was labelled "measured", two `ownWords` bypasses, and scorers that passed bad behavior. All of these are fixed. The paste bypasses and the scorers have tests; the medium light-challenge step and the continuation exits are instructions with no behavioral case yet. A second review then found that medium could wait on a spec approval it doesn't need, a quadratic `ownWords` scan, and two more close-tag bypasses. Those are fixed too, and the medium case now checks the light challenge (the rounds above ran before that check and before medium gained the challenge step).

Limits. The samples are small (8 to 9 runs per arm on the deciding case) and come from one model on synthetic repos. The medium regression signal is within noise but not reassuring; watch it. About $10 of model spend across the rounds.
