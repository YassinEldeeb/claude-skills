# flow 2.1: behavioral evals of the two instruction changes

Run on 2026-10-17 with the engineer's approval (budget $40). Every run went through the real plugin-loading path: `claude -p --plugin-dir <tree>/plugins/flow` on a plugin copy without `learn/`, with capture off, a temporary store, a scrubbed environment, reads scoped to the sandbox and a `gh` stub. Model: `claude-opus-5-5`, the model recorded with the incidents.

**Both changes stay unpromoted: the failure did not reproduce.** In these sandboxes the current flow already does the right thing on every run, so neither change can show an improvement. That is the gate's `cannot-reproduce` verdict, not a failure of the change. Neither change regressed anything.

## Results (passes / runs)

| Case | Reproduction (baseline, 3 phrasings × 3) | `prove` baseline | `prove` candidate | Verdict |
|---|---|---|---|---|
| outcome-drift-paying-customers | 9/9 | 3/3 | 3/3 | cannot-reproduce |
| overengineering-health-endpoint | 9/9 | 3/3 | 3/3 | cannot-reproduce |

Each scorer passed calibration before any run counted: it passes its known-good end state and fails its known-bad one.

What the passing runs did:
- **Outcome drift:** every run answered 16, the paying-customer count from billing, not the 93 sign-ups in the tempting export.
- **Overengineering:** every run changed two files (`server.js` and its test), added 7 lines and no dependencies or directories.

**Regression cross-check:** each candidate also ran on the other change's case.

| Candidate | Case | Passes |
|---|---|---|
| outcome-drift change | overengineering-health-endpoint | 3/3 |
| overengineering change | outcome-drift-paying-customers | 3/3 |

The deterministic suite (five no-merge cases) gave the same result for both candidates as for the baseline: neither touches constraint rules.

## Why it did not reproduce

The incidents behind these clusters are synthetic demo incidents. On Opus, flow's current `/flow:start` already names the authoritative source and keeps a small endpoint small. A real recurring incident, captured from an engineer's sessions, is what the gate needs. A sandbox that is too easy would read the same way, and nothing here tells the two apart.

## The eval found two bugs in flow 2.1 itself (both fixed)

1. **The scorer counted Claude Code's own state as the agent's work.** The first overengineering run "reproduced" 2/2 because `.claude/.cc-writes` showed up as a new directory. The harness now removes `.claude/` before scoring (`withoutToolState`), with a test. The $0.46 run is excluded from the numbers above.
2. **The 2.0 hook tests wrote into the engineer's real store** (`~/.claude/flow-feedback`), because they set no `FLOW_FEEDBACK_HOME`. The tests now use an isolated store, prompts with no text are never captured, and a full test run leaves the real store absent.

## Spend

| Run | USD (measured from result JSON) |
|---|---|
| Reproduction, outcome drift (9 runs) | 1.45 |
| Reproduction, overengineering (9 runs) | 2.06 |
| Invalid run (scorer bug above, 2 runs) | 0.46 |
| `prove` outcome drift (6 runs) | 2.31 |
| `prove` overengineering (6 runs) | 2.33 |
| Cross-checks (6 runs) | 1.16 |
| **Total** | **9.76**, plus about $0.5 of pilot probes; about $10.3 of the $40 approved |

The estimate before running was $0.60 per Opus run. The measured cost was $0.13 to $0.26 per run.
