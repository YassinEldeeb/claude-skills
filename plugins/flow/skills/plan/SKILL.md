---
name: plan
description: Step 2 of flow. Design the simplest correct solution at production scale, find prior art, and attack the plan before building. Use for /flow:plan after acceptance criteria are approved.
---

# Plan

1. **Prior art:** what already exists in the code and merged PRs that you can reuse.
2. **Simplest design** that meets the approved criteria at production scale. Name the bottleneck and the critical path (calls, latency, cost).
3. **Attack it:** have an independent reviewer (a subagent with no context, or another model) find holes. Fix and repeat until nothing new comes up.
4. **Deviations:** anything that differs from the approved design goes in `status.md` under Changed (it ends with `approved by: <name>` only once a human approves) and in `decisions.md` as a 🔴 row with status `open`.
5. **Failing tests/evals** for each criterion: list them; write them in Build.

Output: a 1-page plan (design, reuse, critical path, risks, deviations, time estimate). Stop for approval if there are 🔴 items; otherwise continue.
