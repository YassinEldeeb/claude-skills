---
name: review
description: Step 4 of flow. Independent, adversarial verification of the change before it ships. Use for /flow:review or before opening/merging a PR.
---

# Review

1. **Independent context:** run the review in a subagent (or another model) that never saw the build. Give it the diff, the acceptance criteria and the approved design, and nothing else.
2. **Check:** correctness, blast radius (who else uses the touched code), 2nd and 3rd order effects, privacy and security, and drift from `status.md` Approved.
3. **Evidence, not claims:** re-run the tests; for anything that talks to a real service, verify against the real service or a fake proven as strict.
4. **Fix real findings, re-review** until nothing actionable remains. Skip nits.

Output: findings fixed · findings that need a human (log them as 🔴 open) · the evidence for each acceptance criterion.
