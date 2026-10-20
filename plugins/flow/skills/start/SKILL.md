---
name: start
argument-hint: "<goal>"
description: Use for any non-trivial task in a repo that has .flow/config.json (a feature, a bug fix, an integration, a job), for /flow:start <goal>, and to continue a flow task on the branch. The one entry point of flow - it classifies the risk, then runs every step itself (prove the risky part first, the shortest real path, verify, ship) and comes back only at a human checkpoint or when it's done.
---

# Start

One command runs the whole task. The engineer types `/flow:start <goal>` once. You run every step below in order, without being told the next one, and come back only at a checkpoint (below) or when the work is done. **Never end a turn by telling the engineer to run a flow command: run that step yourself.** The one exception is an approval, which only a human gives.

The goal: catch expensive mistakes (wrong problem, wrong architecture, wrong economics, wrong test method) while they are cheap, show working results early and often, and spend no ceremony on small work.

## 1. Evidence first

Read the relevant code, recent PRs, logs and data. For a bug, find the first cause and whether it's a regression (when, which PR). Small work: minutes, not hours.

**Access first.** List what the task needs that you can't reach yet: a signed-in dashboard, admin page, staging app or vendor console. If you can drive a browser (Claude in Chrome, the built-in browser), ask once, now, in one message: which page to open and what to sign in to (that sign-in is the go-ahead to read there); if you can't, ask for a screenshot or an export instead. Never ask for or type passwords or codes; the engineer signs in. Then use that browser to read, test and unblock yourself, and keep working on everything else while you wait. It is read-only by default: read only what the task needs, and never approve, merge, post approvals, change settings or secrets, or write to production there (🔴).

## 2. Classify

- Read `.flow/config.json` `risk`: which rules will this work trip? On an existing diff run `node .github/flow/flow.mjs classify`.
- **High:** new architecture, distributed or background processing, migrations, auth, privacy, billing, irreversible or costly operations, or any high rule.
- **Medium:** a feature, changed business logic, an external integration, model or prompt behavior, or any medium rule.
- **Small:** everything else.
- When unsure, pick the higher tier. You can never lower a tier yourself: the gate classifies the diff, and lowering needs a human's `override` approval.

## 3. Route

| Tier | Steps, all run by you | Human |
|---|---|---|
| Small | Reproduce → fix → test (the likeliest failure too) → PR with a `## Evidence` section. No task. | None |
| Medium | Task → prove it first (§5) → `/flow:challenge` (light) → `/flow:build` → `/flow:verify` → `/flow:ship` | None, unless you need an override or a 🔴 decision |
| High | Production evidence → task → prove it first (§5) → `/flow:challenge` → draft PR with only the spec → **checkpoint 1** → `flow.mjs sync` → `/flow:build` → `/flow:verify` → `/flow:ship` (**checkpoint 3**) | `spec@` before code, `ship@` before merge |

Each `/flow:<step>` is a skill: load it with the Skill tool (`flow:build`, `flow:verify`, ...) and follow it to its end before the next one. Don't fold a step into another: a medium task isn't done until it has its light challenge (`challenge.simplest` and 2 `challenge.failureModes`), and, when a signal whose rule has `capacity: true` in `.flow/config.json` fires (model-call, external-api, worker, bulk), a top-level `capacity` block in `task.json` (beside `challenge`, not inside it) with `workload.users`, `workload.workPerUser`, `latency.firstResult`, `cost.perUser` and `cut80`, each number with its source; every criterion has evidence in `task.json`, `verify.md` ends with a verdict, and a PR is open (or the one thing blocking it is named).

## 4. The task (medium and high)

Create `.flow/tasks/<ID>/task.json`. The shape is in `../../templates/task.example.json`, relative to this skill's directory. Copy its structure, not its content.

- **id:** `<PREFIX>-<n>`, for example the ticket id. It is permanent; never rename or delete a task.
- **tier, signals:** the rule ids you expect to trip. A signal the gate detects that isn't listed blocks.
- **outcome:** the user outcome being optimized, with a number and a deadline where there is one. Not "memory works".
- **criteria:** every criterion has an id (`<ID>.<n>`), `kind`, `severity` (critical or normal), `verify` (unit, integration, e2e, failure_injection, eval, canary or manual) and a testable `behavior`.
  - **functional:** what must happen.
  - **safety:** what must never happen, for example "an older task never resurrects a forgotten fact". High work needs at least one. A critical one is verified by integration, e2e, failure_injection or eval, never by unit tests alone.
  - **operational:** latency, cost or reliability under representative load. Anything that processes a workload gets one, with the target from the outcome.
- **failure paths:** list every boundary the change crosses (network or API call, database write, queue, file, third-party or model/tool call, auth) and how each can fail: timeout, error response, rate limit, partial write, empty or malformed input, duplicate run. For each, decide the behavior: retry (real backoff and a limit), fallback, fail loudly, or tell the user. Each decision is a criterion (kind `functional`, or `safety` for what must never happen; `verify: failure_injection`; `critical` for the likely ones); if the repo has no CI check for `failure_injection` tests (`config.verify.failure_injection.checks`), add one or prove it with `integration`, never `unit` or `manual`. "It'll probably be fine" is not a decision. In an agent or LLM product, a failed tool returns a clear, specific result to the model (what failed, whether retrying can help, and the best fallback for the user, such as the content inline or a request to paste it) with an instruction not to guess causes or promise retries or ETAs the system doesn't have.
- **decisions:** 🔴 questions with your recommended option. The gate blocks until `chosen` holds what the human decided.
- **branch, pr:** set them, so the hooks and `flow status` find the task.
- **log:** 🟡 notes ("decided X because Y"); not part of the approved spec.

Agree the criteria and how each will be proven before substantial implementation. For medium work, record that agreement in the task. For high work, it is checkpoint 1.

## 5. Prove it first (medium and high)

Plans fail on the assumption nobody ran: a throughput that turns hours into days, an access nobody has, a dependency that is off in production. Before building broadly:

1. **Name the one assumption** that would sink the plan (time and cost at real volume, access you don't control, whether the output is useful).
2. **Run the shape you plan to build on a real sample**, with production's model and settings. A throwaway script is fine; for high work keep it outside the repo (the edit hook holds repo code until the spec is approved). Production access, or model spend beyond a few dollars, needs the engineer's go-ahead first (🔴).
3. **Forecast the whole workload from the measurement**, heaviest real case included, against the target and deadline. Record the sample run in `capacity` as `source: measured` (`ref`, `at`), the whole-workload forecast as `latency.fullCompletion` with `source: estimate` and a `basis` naming that run, and both as round 0 in `progress.md` (§6). A number you didn't run is never `measured`.
4. **If it misses, change the design now:** plan B (prefer an existing faster path) as a 🔴 decision with both forecasts.

Skip only when nothing scales and nothing depends on something you haven't touched; say so in `log`.

## 6. Rounds: a result the engineer can inspect, early and often

- **Name the first reviewable result before substantial work,** in `progress.md`: the smallest real example that shows useful progress (pick the one that exercises the suspected failure, not the easiest to pass), what the engineer will inspect (a before/after diff or output, a screenshot, a running interaction, a command to reproduce; whichever makes the behavior easiest to judge), and what success means for it. For a trivial task, the finished change is the result.
- **Reach it before broadening.** One representative example through the real path first, as the walking skeleton: input → stored → published → used, simulated parts named, every outside dependency (other repos, flags, permissions, data access) wired and checked at its source. For example: one source, facts extracted before/after; one memory section before/after with its token difference; one representative user's published memory and a retrieval; one working interaction before every screen. One builder until it works.
- **Short cycles, each answering one question.** Aim for the first round within about 15–30 minutes when feasible (a target, never a reason to fake progress). If it can't be reached, name the prerequisite and show the smallest evidence you have. A cycle with no inspectable improvement means a smaller next experiment or the blocker fixed, never a wider implementation.
- **Each cycle appends a short round** to `.flow/tasks/<ID>/progress.md` (private examples stay in private storage; no transcripts; commits and test counts aren't progress):

```
## Round 2: one real transcript, before/after (2026-10-19, rev 1a2b3c4)
- goal: keep the decisions a meeting made
- artifact: out/round2/facts-diff.md
- result: 7 of 9 decisions kept (was 3); dates still lost; long transcripts unverified
- scorecard: heavy user done in 14 h (target 2 h) · $3.10 per user (target $1) · 18/20 useful
- next: keep dates in the extraction
- verdict: off-track
```

- **A round is a notification, not a question.** Save it, tell the engineer in a line or two, and go on with the next authorized step. Never ask "shall I continue?", and never read silence as approval for anything outside existing authorization. Fold in feedback when it arrives; a status question or a comment on a round doesn't stop the task unless the engineer redirects or stops it.
- Early rounds guide the build; they don't prove the feature. The task's criteria still decide when it's done.

## 7. Stop and rethink

- **Two strikes:** the same kind of failure fixed twice means stop patching; remove or restrict the operation that causes it. Note it in `log`.
- **Two rounds off-track,** or a missed forecast: no more code. A 🔴 decision with what you measured and plan B, as soon as you know.
- **Measure like production** (model, data, dates, config); anything else is labelled and decides nothing. **Evals stay small:** noise measured first, and if reading 20 outputs answers it, read them.

## Repos without the gate

In a repo with no `.flow/config.json`, run the same steps (classify with `../../templates/config.json`'s risk rules, prove it first, rounds, verify), with two differences:
- **Approvals and merges follow the repo's written policy** (AGENTS.md / CLAUDE.md), not checkpoints 1 and 3: there is no gate to approve against. Standing authorization in that policy counts (for example "merge when green, admin merge allowed"); don't stop to ask for what it already allows. 🔴 decisions (product, privacy, cost, a missed forecast) still go to the human.
- **Keep the task in the PR description** (outcome, criteria, capacity, the latest round) unless the repo asks for `.flow/` files.

## 8. Ask only what's ambiguous

Batch questions as multiple choice, each with your recommended default. A small bug may need none; a new system may need many. Never ask what the code, the data or a sensible default can answer.

## Checkpoints (the only interruptions)

1. **Before high-risk code:** the human approves the outcome, criteria, design trade-offs, capacity and safety boundaries, on one screen (`/flow:challenge` output plus the gate's PR comment).
2. **When an approved boundary changes:** a different architecture, product behavior, a safety or privacy concern, a major cost change, weaker criteria, or a forecast that misses (§7). Edit the spec openly. The gate notices the hash changed and asks again. Bring a recommendation and what each option costs.
3. **Before high-risk merge and rollout:** what works, what's verified, what's unknown, and the exact thing being authorized (`ship@`).

Everything else is yours to decide.

## Keep going

No goal came with the command: use the goal stated in this thread; if there is none, ask for it in one line and stop, without exploring the repo first. An interrupted or killed tool call (exit 137, "the session ended before this call's result was recorded") is never a reason to end the turn: re-run what you need and go on, and never answer "No response requested." while the task is open.

Before you end a turn, the task is waiting for its goal, at checkpoint 1, 2 or 3 or a 🔴 decision (one ready-to-paste ask, and you keep doing what doesn't depend on it), waiting on something outside the session (name it), or done (deployed and verified, or the PR open with the one thing blocking the rest named). A round is not a stop. Otherwise, continue. Stop at once when the engineer says stop or pause; answer a question about something else, then resume the task unless told not to. A later prompt about this task resumes it from `progress.md` and `flow.mjs status <ID>`.
