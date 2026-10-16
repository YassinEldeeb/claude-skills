---
name: verify
description: Independent, adversarial verification of a flow task's behavior before it ships - evidence, safety invariants, integration and eval validity. Use for /flow:verify, before opening or merging a medium or high PR.
---

# Verify

## 1. Independent context

- Run the review in a fresh subagent, or another model, that never saw the build.
- Give it the diff, `task.json` and `design.md`, and nothing else.
- Do not tell it what you think is fine.

## 2. What it checks

- **Each criterion's evidence proves that criterion:**
  - the test exercises the real path, not a mock of the thing being tested;
  - integration and failure-injection tests talk to the real service, or to a fake proven as strict;
  - critical safety invariants are tested by breaking things (a killed commit, a failed publish, a retry, an old task replayed).
- **Blast radius:** who else uses the touched code, and the second- and third-order effects.
- **Privacy and security.**
- **Drift:** the diff against the approved spec, and any new risk signals.
- **Integration:** for a task with `dependsOn`, the combined system works. Two green PRs don't prove their deploy is safe together.

## 3. Evals: validate the measurement before using it

An eval can't count as evidence until its scorer is shown to be right.

- **Gold set:** known-good and known-bad cases (at least `config.minGold`), on the protected branch, not written or changed by this PR. The scorer must classify them correctly.
- **Attribute every failure:** product defect (extraction, persistence, retrieval, agent behavior), eval defect (scorer, probe or fixture), safety failure, or unknown. Record the counts in `task.evals.results` with `runs` (at least `config.minEvalRuns`) and the baseline (same model and config).
- Sample the ambiguous failures and read them; don't trust a regex or a single judge on a disputed case.
- Quality failures inform; they don't block a small internal canary. Unresolved safety failures block. Unknowns block a critical eval.

## 4. Evidence, not claims

Re-run the tests. Read CI's logs for the head commit. Don't accept "it passed locally" for an integration criterion.

## 5. Fix and re-verify

Fix real findings, then verify again until nothing actionable remains. Skip nits.

## Output

`.flow/tasks/<ID>/verify.md`:
- the findings, with what was fixed under each;
- what needs a human (as a 🔴 decision in the task);
- per criterion, the evidence that proves it;
- the last line, `verdict: pass` or `verdict: blocked`.

If the repo lists review bots in `config.reviewBots`, their approving review of the head commit is the verification the gate requires. Still run this step before asking for it.
