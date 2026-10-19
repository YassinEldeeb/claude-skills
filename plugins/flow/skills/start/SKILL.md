---
name: start
description: The one entry point of flow. The engineer types /flow:start <goal> once; you classify the risk, then run every step yourself (prove the risky part first, build the shortest real path, verify, ship) and come back only at a human checkpoint or when it's done. Use for /flow:start <goal>, whenever you begin work in a repo that has .flow/config.json, and to continue a task already on the branch.
---

# Start

One command runs the whole task. The engineer types `/flow:start <goal>` once. You run every step below in order, without being told the next one, and come back only at a checkpoint (below) or when the work is done. **Never end a turn by telling the engineer to run a flow command: run that step yourself.**

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
| Medium | Task → prove it first (§5) → `/flow:build` → `/flow:verify` → `/flow:ship` | None, unless you need an override or a 🔴 decision |
| High | Production evidence → task → prove it first (§5) → `/flow:challenge` → draft PR with only the spec → **checkpoint 1** → `flow.mjs sync` → `/flow:build` → `/flow:verify` → `/flow:ship` (**checkpoint 3**) | `spec@` before code, `ship@` before merge |

Each `/flow:<step>` is a skill: load it with the Skill tool (`flow:build`, `flow:verify`, ...) and follow it to its end before the next one. Don't fold a step into another: a medium task isn't done until every criterion has evidence in `task.json`, `verify.md` ends with a verdict, and a PR is open (or the one thing blocking it is named).

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

Plans fail on the assumption nobody ran: a throughput that turns hours into days, an access nobody has, a dependency that is off in production. Before building broadly:

1. **Name the one assumption** that would sink the plan (time and cost at real volume, access you don't control, whether the output is useful).
2. **Run the shape you plan to build on a real sample**, with production's model and settings. A throwaway script is fine; for high work keep it outside the repo (the edit hook holds repo code until the spec is approved).
3. **Forecast the whole workload from the measurement**, heaviest real case included, against the target and deadline. Record it in `capacity` (`source: measured`, `ref`, `at`, and `latency.fullCompletion`) and as round 0 in `progress.md` (§6).
4. **If it misses, change the design now:** plan B (prefer an existing faster path) as a 🔴 decision with both forecasts.

Skip only when nothing scales and nothing depends on something you haven't touched; say so in `log`.

## 6. Rounds

- **Round 1 is the walking skeleton:** the thinnest real end-to-end path (input → stored → published → used), simulated parts named, every outside dependency (other repos, flags, permissions, data access) wired and checked at its source. One builder until it works.
- **Every round ends with something the engineer can see** and the same scorecard (at most 3 outcome numbers, absolute targets), appended to `.flow/tasks/<ID>/progress.md`:

```
## Round 2: skeleton on real data (2026-10-19)
- shows: what the engineer can now see or do (path or link)
- scorecard: heavy user done in 14 h (target 2 h) · $3.10 per user (target $1) · 18/20 useful
- forecast: whole cohort in 3 days; deadline Tuesday, misses
- verdict: off-track
```

## 7. Stop and rethink

- **Two strikes:** the same kind of failure fixed twice means stop patching; remove or restrict the operation that causes it. Note it in `log`.
- **Two rounds off-track,** or a missed forecast: no more code. A 🔴 decision with what you measured and plan B, as soon as you know.
- **Measure like production** (model, data, dates, config); anything else is labelled and decides nothing. **Evals stay small:** noise measured first, and if reading 20 outputs answers it, read them.

## 8. Ask only what's ambiguous

Batch questions as multiple choice, each with your recommended default. A small bug may need none; a new system may need many. Never ask what the code, the data or a sensible default can answer.

## Checkpoints (the only interruptions)

1. **Before high-risk code:** the human approves the outcome, criteria, design trade-offs, capacity and safety boundaries, on one screen (`/flow:challenge` output plus the gate's PR comment).
2. **When an approved boundary changes:** a different architecture, product behavior, a safety or privacy concern, a major cost change, weaker criteria, or a forecast that misses (§7). Edit the spec openly. The gate notices the hash changed and asks again. Bring a recommendation and what each option costs.
3. **Before high-risk merge and rollout:** what works, what's verified, what's unknown, and the exact thing being authorized (`ship@`).

Everything else is yours to decide.

## Keep going

Before you end a turn, the task is at a checkpoint or 🔴 decision (one ready-to-paste ask, and you keep doing what doesn't depend on it), waiting on something outside the session (name it), or done (deployed and verified). Otherwise, continue. A later prompt on this branch resumes from `progress.md` and `flow.mjs status <ID>`.
