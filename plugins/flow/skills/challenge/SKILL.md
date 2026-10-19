---
name: challenge
description: A step of /flow:start (run it from there; the engineer doesn't call it). Attack a high-risk design before any code is written - production evidence, a measured run of the risky part, alternatives, capacity and cost, failure modes, assumptions - with an independent reviewer. A light version for medium.
user-invocable: false
---

# Challenge

Working code for the wrong architecture is the most expensive outcome. This step decides whether the design deserves to exist.

## 1. Production reality first

- Get real numbers before designing: active users or workspaces, work per user (p50/p95), source volumes, request rates, current latency and cost.
- If you lack access, ask the human for an export or a read-only query they run (🔴: production access). Store what they give you, and cite it as `ref` with the date as `at`.
- Never label a guess "measured". An estimate states its `basis`.

## 2. Answer the seven questions, in `task.challenge`

| Field | Question |
|---|---|
| `task.outcome` | What exact user outcome are we optimizing? |
| `simplest` | What is the simplest implementation that meets it? Reuse before building. |
| `existingMayBeWrong` | Why might the existing architecture be the wrong base for this? |
| `scale` | What happens at real production scale (calls, tokens, concurrency, queueing)? |
| `failureModes` | The 3 most likely ways this fails. |
| `e2eProof` | How will we prove it works end to end, against the real systems? |
| `assumptions` | What could invalidate the whole plan? Each one is `verified` (with evidence) or `unverified` with what it blocks: `merge`, `rollout` or `none`. |

Medium work answers only `simplest` and 2 `failureModes`.

## 3. Alternatives and economics

- `alternatives`: at least 2, including a simpler, incremental or on-demand option. Mark exactly one `chosen`, and say what each costs and drops.
- `capacity`, when a capacity signal fires:
  - `workload.users`, `workload.workPerUser`, `latency.firstResult`, `cost.perUser`, plus any others that matter;
  - each number with `source: measured` (plus `ref` and `at`) or `estimate` (plus `basis`);
  - high work needs at least one measured workload number.
- Answer `cut80` with numbers: **could we drop 80% of this processing and keep most of the user value?** For example: recent-first instead of full history, reuse what's already saved, defer the rest.
- **Measure the deciding assumption before the approval, not after** (`/flow:start` §5). Run the shape you plan to build on a real sample, with production's model and settings, and forecast the whole workload from it, the heaviest real case included. A design whose forecast misses the target is not presented as the choice: the cheaper or faster alternative is.
- Prefer the path that already exists. A new engine, writer or pipeline beside an existing one needs a measured reason.

## 4. Independent attack

- Spawn a reviewer with no shared context: a fresh subagent, or another model. Give it **only** `task.json`, `design.md` and the paths of the code involved. Never give it your reasoning.
- Ask it to find:
  - the wrong problem;
  - a cheaper design with most of the value;
  - scale, cost or latency errors;
  - missing failure modes and safety invariants;
  - assumptions presented as facts;
  - tests that would pass while the real system breaks.
- Fix what it finds and run it again until nothing new comes up.
- Save its final notes as `.flow/tasks/<ID>/challenge-review.md`, with your response under each finding. End with `verdict: pass`, or `verdict: blocked` and why. Never edit its findings.

## 5. The checkpoint 1 screen

Write `design.md` (the design in a page) and give the human one screen:
- the outcome;
- the chosen design against the alternatives (cost, latency, what's dropped);
- the capacity numbers with their sources, and the forecast for the whole workload against the target;
- the unverified assumptions and what they block;
- the safety invariants and how each will be proven.

Then open a draft PR containing only the spec. The gate's PR comment shows the `spec@` line to approve. Ask for it with that line, then keep doing what doesn't need code (the spike, test plans, fixtures). Once it's approved, continue with `flow.mjs sync` and the build yourself.
