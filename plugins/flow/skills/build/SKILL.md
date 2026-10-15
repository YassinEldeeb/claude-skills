---
name: build
description: Step 3 of flow. Execute the approved plan within its boundaries, with failing tests as the finish line. Use for /flow:build.
---

# Build

1. **Write the failing tests/evals first.** Done = they pass (plus the rest of "done" in the rules).
2. **Stay in scope.** New ideas go to a list in the PR, not into this change.
3. **Parallel only when the work splits cleanly:** separate worktrees, one integrator.
4. **Autonomy contract:** 🟢 just do it · 🟡 log in `decisions.md` and continue · 🔴 stop, log as open, ask, and work on anything that doesn't depend on it.
5. **Never idle:** blocked for more than 20 min → write the exact unblock and move to the next item. Time-limit every external call.
6. **Keep `status.md` Building current.** Never switch models or providers silently.

Commit early. When the targets pass, hand off to `/flow:review`.
