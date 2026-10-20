---
name: verify
description: A step of /flow:start (run it from there; the engineer doesn't call it). Independent, adversarial verification of a flow task's behavior before it ships - evidence, safety invariants, integration and eval validity.
user-invocable: false
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
- **Failure paths:** trigger the 2-3 most likely failures for real (kill or fake the dependency, time it out, feed bad input, run it twice) and check the behavior is the one the task decided. What the user sees says what failed and whether anything changed, and gives the best fallback (the content inline, the next step); it never claims a retry, ETA or background process the code doesn't have. In an agent product, check what the model receives when the tool fails: a specific result and the no-guessing instruction, not a bare exception or an empty string.
- **Blast radius:** who else uses the touched code, and the second- and third-order effects.
- **Privacy and security.**
- **Drift:** the diff against the approved spec, and any new risk signals.
- **Integration:** for a task with `dependsOn`, the combined system works. Two green PRs don't prove their deploy is safe together.

## 3. Evals: validate the measurement before using it

An eval can't count as evidence until its scorer is shown to be right.

- **Gold set:** known-good and known-bad cases (at least `config.minGold`), on the protected branch, not written or changed by this PR. The scorer must classify them correctly.
- **Attribute every failure:** product defect (extraction, persistence, retrieval, agent behavior), eval defect (scorer, probe or fixture), safety failure, or unknown. Record the counts in `task.evals.results` with `runs` (at least `config.minEvalRuns`) and the baseline (same model and config).
- Sample the ambiguous failures and read them; don't trust a regex or a single judge on a disputed case.
- **Measure the noise first:** run the baseline twice. A difference smaller than that is not a result.
- **Measure like production:** the eval uses production's model, data shape, dates and settings, or it's labelled as a different setup and decides nothing.
- **Keep it small.** A fixed set that answers the question beats a growing harness; if reading 20 outputs answers it, read them.
- Quality failures inform; they don't block a small internal canary. Unresolved safety failures block. Unknowns block a critical eval.

## 4. Evidence, not claims

Re-run the tests. Read CI's logs for the head commit. Don't accept "it passed locally" for an integration criterion.

## 5. Fix and re-verify

Fix real findings, then verify again until nothing actionable remains, at most 3 passes before a 🔴 decision. Skip nits. When a pass finds the same kind of problem as the last one, fix the kind (every caller, every case), not the instance, and ask whether the operation that causes it can go. On `verdict: pass`, load `/flow:ship` yourself; on `blocked`, raise what blocks it as a 🔴 decision.

## Output

`.flow/tasks/<ID>/verify.md`:
- the findings, with what was fixed under each;
- what needs a human (as a 🔴 decision in the task);
- per criterion, the evidence that proves it;
- the last line, `verdict: pass` or `verdict: blocked`.

If the repo lists review bots in `config.reviewBots`, their approving review of the head commit is the verification the gate requires. Still run this step before asking for it.
