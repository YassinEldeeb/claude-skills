---
name: start
description: The entry point of flow for any non-trivial task. Classifies the risk (small, medium, high), sets up the task, and runs the right steps in order, stopping only at the human checkpoints. Use for /flow:start <goal>, or whenever you begin work in a repo that has .flow/config.json.
---

# Start

The goal: catch expensive mistakes (wrong problem, wrong architecture, wrong economics, wrong test method) before they get expensive, and spend no ceremony on small work.

## 1. Evidence first

Read the relevant code, recent PRs, logs and data. For a bug, find the first cause and whether it's a regression (when, which PR). Small work: minutes, not hours.

## 2. Classify

- Read `.flow/config.json` `risk`: which rules will this work trip? On an existing diff run `node .github/flow/flow.mjs classify`.
- **High:** new architecture, distributed or background processing, migrations, auth, privacy, billing, irreversible or costly operations, or any high rule.
- **Medium:** a feature, changed business logic, an external integration, model or prompt behavior, or any medium rule.
- **Small:** everything else.
- When unsure, pick the higher tier. You can never lower a tier yourself: the gate classifies the diff, and lowering needs a human's `override` approval.

## 3. Route

| Tier | Steps | Human |
|---|---|---|
| Small | Reproduce → fix → test → PR with a `## Evidence` section. No task. | None |
| Medium | Task → `/flow:build` → `/flow:verify` → `/flow:ship` | None, unless you need an override or a 🔴 decision |
| High | Production evidence → `/flow:challenge` → draft PR with only the spec → **checkpoint 1** → `flow.mjs sync` → `/flow:build` → `/flow:verify` → `/flow:ship` (**checkpoint 3**) | `spec@` before code, `ship@` before merge |

Run the steps yourself, in order, without waiting to be told the next one.

## 4. The task (medium and high)

Create `.flow/tasks/<ID>/task.json`. The shape is in `../../templates/task.example.json`, relative to this skill's directory. Copy its structure, not its content.

- **id:** `<PREFIX>-<n>`, for example the ticket id. It is permanent; never rename or delete a task.
- **tier, signals:** the rule ids you expect to trip. A signal the gate detects that isn't listed blocks.
- **outcome:** the user outcome being optimized, with a number where there is one. Not "memory works".
- **criteria:** every criterion has an id (`<ID>.<n>`), `kind`, `severity` (critical or normal), `verify` (unit, integration, e2e, failure_injection, eval, canary or manual) and a testable `behavior`.
  - **functional:** what must happen.
  - **safety:** what must never happen, for example "an older task never resurrects a forgotten fact". High work needs at least one. A critical one is verified by integration, e2e, failure_injection or eval, never by unit tests alone.
  - **operational:** latency, cost or reliability under representative load.
- **decisions:** 🔴 questions with your recommended option. The gate blocks until `chosen` holds what the human decided.
- **branch, pr:** set them, so the hooks and `flow status` find the task.
- **log:** 🟡 notes ("decided X because Y"); not part of the approved spec.

Agree the criteria and how each will be proven before substantial implementation. For medium work, record that agreement in the task. For high work, it is checkpoint 1.

## 5. Ask only what's ambiguous

Batch questions as multiple choice, each with your recommended default. A small bug may need none; a new system may need many. Never ask what the code, the data or a sensible default can answer.

## Checkpoints (the only interruptions)

1. **Before high-risk code:** the human approves the outcome, criteria, design trade-offs, capacity and safety boundaries, on one screen (`/flow:challenge` output plus the gate's PR comment).
2. **When an approved boundary changes:** a different architecture, product behavior, a safety or privacy concern, a major cost change, or weaker criteria. Edit the spec openly. The gate notices the hash changed and asks again. Bring a recommendation and what each option costs.
3. **Before high-risk merge and rollout:** what works, what's verified, what's unknown, and the exact thing being authorized (`ship@`).

Everything else is yours to decide.
