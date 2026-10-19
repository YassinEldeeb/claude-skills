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

## Repos with their own release policy

Some repos already authorize agents to merge (Raptor: merge when green, admin merge allowed, no second approver). flow's hooks and gate act only in repos with `.flow/config.json`, so in such a repo nothing of flow blocks those merges, and there is no flow gate to bypass. The skills now say so: without the gate, the repo's written policy (AGENTS.md / CLAUDE.md) decides approvals and merges, standing authorization counts, and 🔴 decisions still go to the human. With the gate installed, nothing merges past a red `flow` check, `--admin` included; install it only where you want human `spec@`/`ship@` approvals on high-risk work.

## Evidence (2026-10-19, Sonnet, real plugin loading, synthetic repos)

Every check here runs on small synthetic repos with a stand-in model client. None of it is a production measurement.

**A harness defect, found late.** `pluginCopy()` dropped all of `learn/`, but every hook imports `learn/classify.mjs` or `learn/store.mjs`. In every behavioral run before the fix (2.1's included), the hooks crashed on load and Claude Code carried on without them. The copy now drops only `learn/cases` and `test/`, and `pluginSmoke` runs every declared hook before a run counts. The development rounds below ran without hooks, on both arms.

**Final revision (frozen at `dba8421`, the fixed harness, both arms the same harness and scorers, 6 runs per arm per case):**

| Case | master | this branch |
|---|---|---|
| `drive-measure-first`: runs the planned processing on the real sample before the spec approval, forecasts from it (labelled estimate), on a job whose obvious plan misses its 1-hour target | 0/6 | 3/6 |
| `drive-medium-forecast`: one prompt carries a medium feature to verified, with the light challenge the gate requires | 0/6 | 2/6 |
| `drive-first-result`: a round with an existing artifact and a result, then the work goes on to verified without asking to continue (an acceptance check for this branch; master was never told to do it) | n/a | 3/6 |
| Suite: `drive-two-misses`, `outcome-drift-paying-customers`, `overengineering-health-endpoint` | 8/8 | 8/8 |

Reading the failures:
- **master's medium zero** is the light challenge: master never writes it, so its medium tasks would fail its own gate. Its task and verify behavior was otherwise often fine.
- **This branch's medium misses:** two put `capacity` inside `challenge` instead of at the top level of `task.json` (fixed in `a90049a`, see below). The plain-language prompt (no `/flow:start`) produced no flow task on either arm (0 of 4 per arm): typing `/flow:start` is still needed.
- **Measure-first misses:** both arms often skip creating a task for the plain-language prompt. When this branch did create a task, it usually ran the sample.

**After the frozen run:** `a90049a` says where the capacity block goes. Confirmation, this branch only, slash prompts, 8 runs: `drive-first-result` 4/4, `drive-medium-forecast` 2/4. Every run that wrote `capacity` put it at the top level now (6 of 8). The two medium misses: one wrote no capacity block at all, and one listed no signals and built an injected provider instead of calling the README's URL. That's the agent's judgement, not the placement.

**Development rounds (before the harness fix; pooled across changing revisions, so indicative only):** measure-first ran the sample in 5 of 8 runs on this branch against 1 of 9 on master (counted from transcripts); medium was within noise; two-misses didn't reproduce on master.

Limits: small samples, one model, synthetic repos with a stand-in provider. The behavior on real repos and real workloads is unmeasured. About $18 of model spend across all rounds.
