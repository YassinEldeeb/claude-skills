---
name: start
description: The one entry point of flow. The engineer types /flow:start <goal> once; you classify the risk, then run every step yourself (prove the risky part first, build the shortest real path, verify, ship) and come back only at a human checkpoint or when it's done. Use for /flow:start <goal>, whenever you begin work in a repo that has .flow/config.json, and to continue a task already on the branch.
---

# Start

One command runs the whole task. The engineer types `/flow:start <goal>` once. You run every step below in order, without being told the next one, and come back only at a checkpoint (below) or when the work is done. **Never end a turn by telling the engineer to run a flow command: run that step yourself** (load the skill named in the table with the Skill tool and follow it).

The goal: catch expensive mistakes (wrong problem, wrong architecture, wrong economics, wrong test method) while they are cheap, show working results early and often, and spend no ceremony on small work.

## 1. Evidence first

Read the relevant code, recent PRs, logs and data. For a bug, find the first cause and whether it's a regression (when, which PR). Small work: minutes, not hours.

## 2. Classify

- Read `.flow/config.json` `risk`: which rules will this work trip? On an existing diff run `node .github/flow/flow.mjs classify`.
- **High:** new architecture, distributed or background processing, migrations, auth, privacy, billing, irreversible or costly operations, or any high rule.
- **Medium:** a feature, changed business logic, an external integration, model or prompt behavior, or any medium rule.
- **Small:** everything else.
- When unsure, pick the higher tier. You can never lower a tier yourself: the gate classifies the diff, and lowering needs a human's `override` approval.

## 3. Route

| Tier | Steps, all run by you | Human |
|---|---|---|
| Small | Reproduce → fix → test → PR with a `## Evidence` section. No task. | None |
| Medium | Task → prove it first (§5) → `flow:build` → `flow:verify` → `flow:ship` | None, unless you need an override or a 🔴 decision |
| High | Production evidence → task → prove it first (§5) → `flow:challenge` → draft PR with only the spec → **checkpoint 1** → `flow.mjs sync` → `flow:build` → `flow:verify` → `flow:ship` (**checkpoint 3**) | `spec@` before code, `ship@` before merge |

## 4. The task (medium and high)

Create `.flow/tasks/<ID>/task.json`. The shape is in `../../templates/task.example.json`, relative to this skill's directory. Copy its structure, not its content.

- **id:** `<PREFIX>-<n>`, for example the ticket id. It is permanent; never rename or delete a task.
- **tier, signals:** the rule ids you expect to trip. A signal the gate detects that isn't listed blocks.
- **outcome:** the user outcome being optimized, with a number and a deadline where there is one. Not "memory works".
- **criteria:** every criterion has an id (`<ID>.<n>`), `kind`, `severity` (critical or normal), `verify` (unit, integration, e2e, failure_injection, eval, canary or manual) and a testable `behavior`.
  - **functional:** what must happen.
  - **safety:** what must never happen, for example "an older task never resurrects a forgotten fact". High work needs at least one. A critical one is verified by integration, e2e, failure_injection or eval, never by unit tests alone.
  - **operational:** latency, cost or reliability under representative load. Anything that processes a workload gets one, with the target from the outcome.
- **decisions:** 🔴 questions with your recommended option. The gate blocks until `chosen` holds what the human decided.
- **branch, pr:** set them, so the hooks and `flow status` find the task.
- **log:** 🟡 notes ("decided X because Y"); not part of the approved spec.

Agree the criteria and how each will be proven before substantial implementation. For medium work, record that agreement in the task. For high work, it is checkpoint 1.

## 5. Prove it first (medium and high)

Before building broadly, run the riskiest part for real, small, and measure it. Plans fail on the assumption nobody ran: a throughput that turns days into weeks, an access nobody has, a dependency that is off in production, an output nobody finds useful.

1. **Name the one assumption** that, if wrong, makes the plan worthless. Usually: time and cost at real volume, access to data or a system you don't control, or whether the output is useful at all.
2. **Run the shape you plan to build**, not one component of it, on real data: a real sample, production's model, provider and settings. A throwaway script is fine (for high work keep it outside the repo or under `.flow/tasks/<ID>/spike/`: the edit hook holds repo code until the spec is approved).
3. **Measure and forecast.** Record time, calls and cost, and read a sample of the output. Scale it to the whole workload (the heaviest real case, not the average) and compare with the outcome's target and deadline. Put the numbers in `capacity` (`source: measured`, `ref`, `at`), including `latency.fullCompletion`.
4. **If the forecast misses, change the design now.** Bring plan B (prefer a faster path that already exists) as a 🔴 decision with both forecasts. Don't start building plan A and hope.
5. Write it down as round 0 in `.flow/tasks/<ID>/progress.md` (format in §6).

Skip this only when nothing in the task scales or depends on something you haven't touched, and say so in `log`.

## 6. Rounds: the shortest real path first, then show it every time

- **Round 1 is the walking skeleton:** the thinnest path through the real system, end to end (input → stored → published → used by the next real step), with anything simulated named. Wire every dependency you don't control (other repos, flags, permissions, data access) in this round, and check each one in its source of truth, not in a report.
- **One builder until round 1 works.** Parallel builders (`flow:orchestrate`) only after it, contracts first.
- **Every round ends with something the engineer can see** (an output file, a real run, a screenshot) and the same scorecard: at most 3 outcome numbers, against absolute targets, never only "no regression against main". Append it to `progress.md`:

```
## Round 2: skeleton on real data (2026-10-19)
- shows: what the engineer can now see or do, with the path or link
- scorecard: heavy user done in 14 h (target 2 h) · $3.10 per user (target $1) · 18/20 useful in a read sample
- forecast: whole cohort in 3 days at this rate; deadline Tuesday, misses
- verdict: off-track
```

`verdict` is `on-track` or `off-track`.

## 7. Stop and rethink (all the way through)

- **Two strikes:** the same kind of failure fixed twice means stop patching. Ask which operation you can remove or restrict so the whole class can't happen (a smaller allowed edit, a structural constraint instead of a text rule). Record the answer in `log`.
- **Two rounds off-track,** or a scorecard that didn't move: stop adding code. Raise a 🔴 decision: what you measured, why it isn't converging, plan B with its forecast.
- **A forecast that misses the deadline** is said the moment you know it, with plan B. Never compensate with optimistic reporting or quietly smaller scope.
- **Measure like production:** same model, data shape, dates and config. A number from a different setup is labelled as such and decides nothing.
- **Evals stay small:** a fixed set that answers the question, its noise measured first (run the baseline twice). If reading 20 outputs answers it, read them. Eval code never outgrows the product.
- **Know the cycle cost** (CI, review bots, deploy waits) and batch small fixes into one push.

## 8. Ask only what's ambiguous

Batch questions as multiple choice, each with your recommended default. A small bug may need none; a new system may need many. Never ask what the code, the data or a sensible default can answer.

## Checkpoints (the only interruptions)

1. **Before high-risk code:** the human approves the outcome, criteria, design trade-offs, capacity and safety boundaries, on one screen (`flow:challenge` output plus the gate's PR comment).
2. **When an approved boundary changes:** a different architecture, product behavior, a safety or privacy concern, a major cost change, weaker criteria, or a forecast that misses (§7). Edit the spec openly. The gate notices the hash changed and asks again. Bring a recommendation and what each option costs.
3. **Before high-risk merge and rollout:** what works, what's verified, what's unknown, and the exact thing being authorized (`ship@`).

Everything else is yours to decide.

## Keep going

After each step, start the next one. Before you end a turn, check where the task is:
- **at a checkpoint or a 🔴 decision:** say what you need in one ready-to-paste ask, then keep doing the work that doesn't depend on it;
- **waiting on something outside the session** (CI, a deploy, a long run): name it and how you'll know it's done;
- **done:** deployed and the canary criteria verified, or the engineer stopped it.

Otherwise, continue. On a later prompt in the same branch, pick the task up where `progress.md` and `flow.mjs status <ID>` say it is; the engineer doesn't type `/flow:start` again.
