---
name: investigate
description: Step 1 of flow. Understand the task or bug and pin down the intended behavior with evidence before any plan or code. Use for /flow:investigate or at the start of any non-trivial task.
---

# Investigate

1. **Evidence first:** read the relevant code, recent PRs, logs and data. For a bug, find the first cause and whether it's a regression (when, which PR).
2. **Ask only what's ambiguous.** Batch questions as multiple choice, each with your recommended default. A small bug may need none; a new feature may need 20+.
3. **Propose acceptance criteria:** the behavior that must hold, each one testable. Mark which become failing tests or evals.
4. **Write `status.md`** Goal and a draft Approved line.

Output (one screen): what's true today (with evidence) · questions with defaults · proposed acceptance criteria. Stop for approval of the criteria (🔴: they define done).
