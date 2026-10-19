---
name: build
description: A step of /flow:start (run it from there; the engineer doesn't call it). Build a flow task inside its approved boundaries - the walking skeleton first, failing tests as the finish line, a round shown at each milestone.
user-invocable: false
---

# Build

1. **High work:** first `node .github/flow/flow.mjs sync <ID>`. The edit hook holds code changes until the approved spec is recorded.
2. **Walking skeleton first** (round 1 in `/flow:start` §6): the thinnest end-to-end path through the real system, with every dependency you don't control wired and checked in its source of truth. Show it and record the round in `progress.md` before widening anything. One builder until it works.
3. **Write the failing tests first,** one or more per criterion, of the agreed kind:
   - integration tests where `config.verify.integration.paths` says;
   - fault-injection tests that really break the commit, the network or the process;
   - an eval only with a validated gold set (see `/flow:verify`).
   Exploration before the tests is fine; changing the agreed proof is not.
4. **Stay in scope.** New ideas go in the PR's follow-up list, not into this change.
5. **The boundaries are the spec.** If the work needs a different design, criteria, tier or a new risk signal:
   - edit `task.json`/`design.md` openly;
   - add the 🔴 decision with your recommendation;
   - ask, and keep building whatever doesn't depend on the answer.
   The spec hash changes, so the old approval lapses on its own. Never weaken a criterion quietly.
6. **Record evidence as you go:** `evidence["<ID>.<n>"] = ["test:<path>#<test name>", "ci:<check>", …]`. The gate checks that each ref exists, isn't skipped and passed on the head.
7. **Autonomy:** 🟢 just do it · 🟡 one line in `log` · 🔴 decision and ask.
8. **Never idle.** Blocked for more than 20 minutes: write the exact unblock, move to the next item, and come back. Time-limit every external call. After two attempts at the same failure without new evidence, stop and escalate the unresolved assumption instead of retrying.
11. **Rounds and strikes.** At each milestone, show the result and append a round with the scorecard to `progress.md`. The same kind of bug fixed twice, or two rounds off-track, means stop adding code and rethink (`/flow:start` §7): which operation can you remove so the class can't happen, or which faster path meets the target?
9. **Never switch models or providers silently.** Every number you report names its source, model and date.
10. **Parallel work** only after the skeleton works and when the task splits cleanly: separate worktrees and one integrator (`flow:orchestrate`).

Commit early. Run `node .github/flow/flow.mjs classify` when you touch a new area. When the tests pass, run `flow:verify` yourself.
