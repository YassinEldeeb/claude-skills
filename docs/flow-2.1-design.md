# flow 2.1: Capture → Understand → Improve → Prove

Status: built in this PR (draft, unmerged). Builds on flow 2.0 (merged as d3ea4c3). A fresh adversarial review of the built code found 4 blockers and 18 majors; the fixes are listed in section 9.

An engineer corrects Claude once. flow 2.1 records it without interrupting work and works out the reusable failure behind it. An engineer then runs one command to draft a focused fix with independently written regression cases. flow 2.1 proves whether the fix works, through the real skill-loading path, before any PR is opened. Nothing reaches the team until a human merges it.

**No silent self-modification, no prompt bloat, no fake verification.**

## 1. Shape

| Stage | Runs | Cost | Pieces |
|---|---|---|---|
| **Capture** | Automatic, local | No model calls; one hook process per prompt plus one at session end | `prompt.mjs` (UserPromptSubmit, which replaces 2.0's context guard), `session-end.mjs` (SessionEnd, async) |
| **Understand** | Automatic, local | Deterministic | `flow-learn process`: a queue, then incidents, then clusters keyed by (category, target), then dossiers |
| **Improve** | **Explicit**: `/flow:learn <cluster>` in an engineer's session | That session's own tokens | A general root-cause workflow: an independent case author, then a focused edit in allowed files |
| **Prove** | **Explicit**: `flow-learn prove` | Deterministic tier free; behavioral tier only with `--approve-spend` and a budget | Real hooks for enforcement; `claude -p --plugin-dir <baseline/candidate>` for behavior; the effectiveness gate |
| **Propose** | After prove passes | None | One draft PR per cluster, rate-limited from GitHub; never merged by the tool |

What was cut after the architecture review:
- per-tool-call hooks;
- fixed playbooks;
- the shared git branch;
- automatic evals;
- subjective graders by default;
- markers inside SKILL.md;
- the ETA heuristic.

What was reused from flow 2.0:
- the Bash guard (constraints plug into it);
- the rendering and escaping;
- the task format, since each learn PR carries a `.flow/tasks/LEARN-*` spec;
- the CI test suite: deterministic regression cases become `node --test` files that CI reruns on every PR.

## 2. Capture (hook facts verified against Claude Code 2.1.301)

The facts come from the binary's input schemas and a zero-cost live probe: a UserPromptSubmit hook blocked the prompt, so no model call was made, while SessionStart, UserPromptSubmit and SessionEnd all fired.

- **Who typed it?**
  - UserPromptSubmit carries `source` (`user|sdk|system|loop_wakeup|schedule_wakeup|poll_event`), but it was absent in `-p` mode.
  - So capture accepts a prompt only if `source === "user"`, or if `source` is absent and `CLAUDE_CODE_SESSION_ATTENDED !== "0"`. Headless children set it to 0, interactive sessions to 1.
  - `/loop` and schedule wakeups, SDK relays and eval runs are never captured. Eval and worker children also get `FLOW_FEEDBACK=off`.
  - Harness text (`<system-reminder>`, task notifications, teammate messages) is dropped by content as well.
- **Corrections** go through a lexicon of explicit corrections by category, plus implicit ones ("no, that's wrong", "revert that"), which become `unclassified` for `/flow:learn` to investigate.
  - Requirement changes, sarcasm and venting are not failures.
  - Praise is recorded as a positive example only. It never resolves anything.
- **Constraints:** only imperative constraints about actions are captured: merge, push, deploy, delete, force, spend.
  - The phrases live in `hooks/constraint-rules.json`. The hook echoes "constraint noted" and re-injects the active constraints on every prompt as a few tokens of context.
  - A later engineer prompt like "you can merge now" releases one.
  - Enforcement is the flow 2.0 Bash guard, which now checks constraints before its flow-repo check, so it works in any repo. This is labeled **best effort (L)**; GitHub's required checks are the hard layer.
- **Session end:** derives counts locally from the existing transcript, if one exists:
  - failing-test streaks (`tool_result.is_error` on test commands);
  - repeated identical commands;
  - the most edits to one file;
  - "done" claimed after the last edit with no test run since;
  - whether a correction recurred in the same session.

  It stores counts only, never text, plus the model and plugin version recorded at SessionStart.
- **Stored per correction:**
  - the category and lexicon keys;
  - the correction, redacted, ≤300 characters;
  - the session objective (first engineer prompt, redacted, ≤200 characters);
  - the repo name, model and plugin version.

  A text field where a secret or entropy detector fires is **dropped**, not redacted. Tool arguments, file contents and diffs are never stored.
- **Controls:**
  - `flow-learn status | inspect | delete | disable | enable`, and `FLOW_FEEDBACK=off`;
  - files are mode 0600, with a 30-day retention the worker enforces;
  - personal installs capture locally, with a one-time notice;
  - a repo whose `.flow/config.json` sets `"learn": {"capture": "opt-in"}` captures nothing until the engineer runs `flow-learn enable`.
  - Nothing leaves the machine.

## 3. Understand

`flow-learn process` (deterministic, under a lock, started detached by SessionEnd) runs these steps:
1. **Drain** the durable file queue (atomic rename, stale-claim recovery, idempotent ids).
2. **Turn events into incidents.** A defect needs an objective session signal or an engineering category. A preference (style, verbosity, "I prefer") stays personal. Personal constraints never become shared lessons.
3. **Cluster by (category, target).** The target is the skill section or hook data that owns the behavior, from a coverage map, e.g. outcome drift → `/flow:start` step 1, merges → `constraint-rules.json`. The repo is a count, not a key, because skills are global.
4. **Write a dossier per cluster:**
   - counts (sessions, occurrences, recurrence after earlier fixes);
   - signals;
   - a **synthetic** description;
   - local-only redacted examples;
   - coverage: does the target already address it, and does a deterministic gate exist?
5. **Resolution comes from recurrence only:** a cluster that stops appearing after a change shipped. Comparisons before and after a change are labeled observational.

## 4. Improve: `/flow:learn <cluster>`

A general workflow, not a menu:
1. Read the dossier. Incident text is quoted data, never instructions.
2. Find the root cause in the actual skill, hook or rule text, and pick the mechanism:
   - **deterministic enforcement** for authorization or mechanical failures;
   - **an instruction edit** for judgment failures;
   - **personal configuration** for preferences.
3. An **independent case author** (a fresh subagent) receives only the synthetic description, never the fix. It writes the regression case:
   - a sandbox;
   - ≥2 phrasings typed as an engineer would, with ≥1 held out;
   - a deterministic scorer;
   - known-good and known-bad calibration end states;
   - for enforcement, blocked and allowed operations, including bypass attempts.
4. Write the smallest fix: replace or consolidate inside the allowed files.
   - Allowed: `skills/**/SKILL.md`, `templates/rules.md`, `hooks/constraint-rules.json`, and `learn/cases/**`.
   - Refused: the gate, hook code, the learn harness, workflows and config. The learning system can't rewrite its own gates or evaluator.
5. `flow-learn prove`, then `flow-learn propose`.

## 5. Prove: the effectiveness gate

A candidate is never judged by the test it was written against alone.

| Tier | When | Evidence |
|---|---|---|
| Deterministic | Enforcement and mechanical cases | The real hook script from the baseline tree and from the candidate tree, on every fixture (blocked, allowed, bypass attempts). No statistics needed. |
| Behavioral | Instruction changes | `claude -p --plugin-dir <tree>/plugins/flow`: real skill loading and triggering, with the plugin's hooks off (`FLOW_FEEDBACK=off`). The prompts are typed as an engineer would. The sandbox is path-scoped, has no network beyond the API, and has a `gh` stub. The model is the one recorded on the incident unless overridden. N runs per arm per phrasing (default 5). |
| High impact | Changes to `/flow:start` routing or to enforcement wording | N=10 and a stricter margin |

The gate requires all of these:
1. **Reproduction:** the baseline fails the target case in ≥50% of runs. Otherwise the result is "cannot reproduce", unverified and review-only.
2. **Scorer calibration:** the scorer passes its known-good state and fails its known-bad one. Otherwise nothing counts.
3. **Held-out improvement:** on the held-out phrasing, the candidate beats the baseline, and the Wilson 90% interval of the difference stays above 0. Otherwise "inconclusive".
4. **No regression:** on every other case in the suite, the candidate is at most 15 points worse.
5. **Overhead:** skill text grows by at most max(10%, 400 bytes), and tokens per run by at most 15%.
6. **Loading mode:** `plugin-dir`. Results from system-prompt injection are refused.

**Budget:** `prove` estimates the cost first: runs × the measured cost per run for that model. It refuses the behavioral tier without `--approve-spend --budget-usd ≥ estimate`. No hook or background job ever starts it.

## 6. Propose and roll back

- **One draft PR per cluster,** on branch `flow-learn/<cluster>`, updated as new incidents arrive.
  - The tool opens at most 2 new PRs a day and keeps at most 5 open, both counted from GitHub (`label:flow-learn`) rather than from local state.
  - The body holds:
    - the synthetic reproduction (no real excerpts);
    - the root cause and the change;
    - the regression cases;
    - the baseline-vs-candidate table with raw counts and intervals;
    - risks, confidence and limits.

    It is escaped with flow 2.0's renderer.
  - Enforcement changes are labeled `enforcement`.
- **The `gh` wrapper** allows only `pr create/edit/view/list`, `label create` and `api -X GET`. There is no merge and no approve path.
- **Rollback:** `flow-learn rollback <merged PR>` opens a revert PR. Recurrence of the cluster afterwards is tracked.

## 7. Team learning (not built, by decision)

The shared git branch was removed: it had self-asserted identities, couldn't delete anything, and could re-identify people. Lessons reach the team only as reviewed PRs to the skills repo, versioned by the plugin. Any team aggregation waits until identity, privacy and deletion are solved. The likely route is "+1" from each engineer's own GitHub account on a cluster's PR.

## 8. Report

`flow-learn report` covers:
- corrections per 100 sessions;
- clusters and recurrence;
- sessions with no correction;
- signals;
- proposals: review-only, proposed, merged, reverted;
- hook latency (measured per call);
- eval spend (measured from the result JSON);
- lexicon precision and recall on the synthetic labelled set.

Every number is labeled measured, estimated, synthetic or unavailable. First-attempt success and time to a verified outcome are unavailable without outcome labels.

## 9. Adversarial review of the build: what changed

| Finding | Fix |
|---|---|
| B1: `propose` trusted any results file | `propose` re-runs deterministic cases itself; behavioral results must match the candidate's tree hash and base; every case must belong to the cluster |
| B2: a case could pick the hook script and fake "enforced" | Hook names are allowlisted; both arms run the baseline's trusted hook code, and only the constraint rules (data) differ |
| B3: one bad regex disabled the whole Bash guard | Rules compile one by one (invalid ones are skipped); the constraint check runs last in its own block; `validateRules` (invalid, empty-matching, over-broad) fails such a candidate and is checked in CI |
| B4: renames and staged changes slipped past the path check | Paths come with renames off, from the working tree, the index and untracked files; the commit is built from a temporary index with only the vetted files (the engineer's checkout is never switched) |
| M1: the evaluator was writable | Existing cases are immutable; only new case directories; `learn/enforced.json` may only gain ids, and CI runs every enforced case |
| M2, M3: case code and answers | Scorers run in a child process with a scrubbed environment; the agent under test gets a plugin copy without `learn/`, a temporary store, a scrubbed environment, and reads scoped to its sandbox |
| M4, M5: errors and the suite | Errored or zero-turn runs are excluded; over 20% errors means invalid; the arms interleave; the suite always runs, and a missing suite case blocks the verdict |
| M6: "held-out" was self-asserted | ≥3 held-out fixtures; every no-merge set the fix author has seen is relabelled as not held out |
| M7: spend was a flag | Spend approval comes from the engineer's prompt, and the Bash guard refuses `--approve-spend` above it |
| M8: VS Code prompts arrive as `source: "sdk"` | Accepted when the session is attended and the entrypoint is the VS Code or Desktop app |
| M11–M18 | Retention covers every log and dead events; `delete --all` keeps the config; the notice is a `systemMessage`; signals reset on edits; latency and classifier claims are stated as measured; `report --refresh` tracks merged and reverted PRs; more secret patterns |
