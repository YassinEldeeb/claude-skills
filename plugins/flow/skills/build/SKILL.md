---
name: build
description: Build a flow task inside its approved boundaries, with failing tests as the finish line. Use for /flow:build, after /flow:start (medium) or after the spec approval (high).
---

# Build

1. **High work:** first `node .github/flow/flow.mjs sync <ID>`. The edit hook holds code changes until the approved spec is recorded.
2. **Write the failing tests first,** one or more per criterion, of the agreed kind:
   - integration tests where `config.verify.integration.paths` says;
   - fault-injection tests that really break the commit, the network or the process;
   - an eval only with a validated gold set (see `/flow:verify`).
   Exploration before the tests is fine; changing the agreed proof is not.
3. **Stay in scope.** New ideas go in the PR's follow-up list, not into this change.
4. **The boundaries are the spec.** If the work needs a different design, criteria, tier or a new risk signal:
   - edit `task.json`/`design.md` openly;
   - add the 🔴 decision with your recommendation;
   - ask, and keep building whatever doesn't depend on the answer.
   The spec hash changes, so the old approval lapses on its own. Never weaken a criterion quietly.
5. **Record evidence as you go:** `evidence["<ID>.<n>"] = ["test:<path>#<test name>", "ci:<check>", …]`. The gate checks that each ref exists, isn't skipped and passed on the head.
6. **Autonomy:** 🟢 just do it · 🟡 one line in `log` · 🔴 decision and ask.
7. **Never idle.** Blocked for more than 20 minutes: write the exact unblock, move to the next item, and come back. Time-limit every external call. After two attempts at the same failure without new evidence, stop and escalate the unresolved assumption instead of retrying.
8. **Never switch models or providers silently.** Every number you report names its source, model and date.
9. **Parallel work** only when the task splits cleanly: separate worktrees and one integrator (see `/flow:orchestrate`).

Commit early. Run `node .github/flow/flow.mjs classify` when you touch a new area. When the tests pass, go to `/flow:verify`.
