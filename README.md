# claude-skills

```bash
claude plugin marketplace add YassinEldeeb/claude-skills
```

## flow: shipping with AI

```bash
claude plugin install flow@yassin-skills
```
Then, in your repo: `/flow:install`.

flow scales the rigor to the risk. A typo ships with no ceremony. A new background pipeline gets its architecture, economics and test method challenged **before** the code exists, and can't merge without evidence and a human's approval of exactly what ships.

| Command | What it does |
|---|---|
| `/flow:start <goal>` | **The entry point.** Classifies the risk (small / medium / high) and runs the right steps in order, stopping only at the human checkpoints |
| `/flow:challenge` | Production evidence, the 7 design questions, alternatives, capacity and cost ("could we drop 80% of this?"), an independent attack |
| `/flow:build` | Builds to failing tests inside the approved spec |
| `/flow:verify` | Independent check of behavior, safety invariants, integration and eval validity |
| `/flow:ship` | PR with evidence, gate green, merge, deploy through the pipeline, verify live |
| `/flow:status` | Where each task really is: built → tested → integrated → merged → deployed → authorized |
| `/flow:orchestrate` | Optional: several builders on dependent tasks, contracts first, one verified release |
| `/flow:install` | Installs or upgrades flow in a repo (also migrates flow 1.x) |

### How it works

| Tier | Decided by | Needs | Human |
|---|---|---|---|
| 🟢 Small | No risk rule matches the diff | A `## Evidence` section in the PR | Nothing |
| 🟡 Medium | A medium rule (prompts, model calls, external APIs, deploy config, dependencies, a new module, 500+ lines) | `.flow/tasks/<ID>/task.json`: outcome, typed criteria with checked evidence, a light challenge, independent verification | Nothing, unless it lowers its tier or waives a step |
| 🔴 High | A high rule (migrations, auth, billing, privacy, workers and queues, bulk jobs, the gate or any CI workflow) or a diff too large to scan | All of medium, plus `design.md`, the full challenge with an independent review, a capacity model with at least one measured number, a safety invariant | `spec@` before code, `ship@` before merge |

- **The gate** (`.github/workflows/flow.yml`) runs on `pull_request_target` and `issue_comment`. That means it runs the protected branch's code and config, never the PR's. It reads the PR through the API and posts a `flow` check run plus one dashboard comment.
- **The tier comes from the diff.** A builder can only raise it: lowering needs an `override` approval.
- **Approvals are PR comments bound to content.** For example: `/flow approve MEM-12 spec@<hash>`.
  - `spec@` covers `task.json`, `design.md` and the challenge review.
  - `ship@` covers the PR's exact changes.
  - Change what was approved and the approval lapses.
  - They count only from `approvers` or `signers` in the protected branch's config, never from agents, bots or edited comments. In **signed mode**, only an SSH signature by a listed key counts, so approvals hold even when agents share a human's GitHub login.
- **Evidence is checked, not claimed:**
  - a test ref must be declared as a test, not be skipped, and live where that kind of test lives; the CI check that runs that kind (`config.verify.<kind>.checks`) must have passed on the head;
  - a critical safety invariant can't be proven by a unit test;
  - an eval counts only after its scorer passes a gold set that's already on the protected branch;
  - a dependency counts only once its own PR merged.
- **It fails closed:** missing or invalid config or task, an unknown schema, an API error, or a diff too large to list all mean red.

### What enforces what

| Layer | Strength | Bypass needs |
|---|---|---|
| `flow` required check, **hardened mode** (your App posts it; key in an environment limited to the protected branch) | Hard | Repo-admin rights, or a human's approval |
| `flow` required check, standard mode (GitHub Actions posts it) | Hard against mistakes. A deliberately malicious agent with write access could forge a check from a workflow it adds. | That agent pushing a workflow file. Deny agents the `workflow` scope: a same-repo PR's workflow can ask for `checks: write` whatever the default token is |
| Signed approvals | Hard, even with a shared GitHub login | The human's signing key (prefer one that needs a touch) |
| Login approvals | Hard only if agents have their own GitHub identity | The approver's GitHub session |
| Hooks (plugin) | Best effort | Ignoring them. They hold high-risk code until the spec is approved, and refuse self-approval, `--admin` merges and protection changes |
| Rules in CLAUDE.md / AGENTS.md | Advisory | Nothing |

**To make it hard** (`node .github/flow/flow.mjs doctor` checks most of this):
1. Make `flow` a required check, pinned to its source app.
2. Require branches to be up to date before merging.
3. Turn on enforce admins, with no agent in any bypass list.
4. Give agents a token without admin or `workflow` scope; this is what stops a PR from adding a workflow that posts a fake `flow`.
5. Set the default workflow token to read-only, so existing workflows that run PR code can't post checks unless they ask.
6. Use signed approvals, or a separate agent identity listed in `agents`.

### Verified on real GitHub

Tested on 2026-10-16 in a private throwaway repo: a ruleset requiring `flow` from GitHub Actions, no bypass actors, standard mode.

| Test | Result |
|---|---|
| A migration PR with no task | `flow` red; GitHub refuses the merge, `--admin` included |
| A high-risk PR | Merges only after the `spec@` and then the `ship@` approval; each comment re-runs the gate |
| Editing an approval comment | The approval stops counting; red again; merge refused |
| Pushing a change after `ship@` | The ship approval lapses; after a clean rebase onto main, it still holds (same changes) |
| CI finishing | `workflow_run` re-runs the gate, so CI checks count as evidence without a comment |
| The same commit as a PR into an unprotected branch | Posts no `flow` check, so it can't turn the main PR green |
| Signed mode | Only the configured key's signature counts; unsigned and wrong-key approvals are ignored with the reason |
| A PR workflow posting a fake `flow: pass` | **Forgery works in standard mode**: the PR became mergeable and merged. This is the documented limit; deny agents the `workflow` scope, or use hardened mode |
| Hardened mode (App) | **Not tested**: needs a GitHub App and its key |

### Limits, honestly

- **Standard mode can be forged** by anyone who can push a workflow file (verified above).
- **A shared commit can block the merge.** Once a commit has also been the head of a PR into another branch, GitHub stopped counting `flow` for its merge into main ("Required status check flow is expected"), even after that PR closed. Seen 3 of 3 times in the e2e test; the cause is inferred, not documented by GitHub. It fails safe. Push a new commit (an empty one keeps the ship approval); the dashboard says so while the other PR is open.
- **Two PRs into two protected branches can't share a commit:** check runs belong to the commit, so their verdicts would overwrite each other. The gate blocks this.
- The gate checks completeness and references, not quality. A test that exists and passes can still test the wrong thing; the independent challenge and verification, and the human at checkpoint 1, are what judge design and test quality.
- Capacity numbers and eval counts are written by the agent. The gate demands sources and dates, and shows them on the approval card for a human to judge.
- "Before implementation" is enforced locally (the edit hook), not in CI. CI can't know when code was written.
- Deploy verification is repo-specific. The dashboard shows `deployed` only from GitHub deployment records; `flow.mjs rollout-ok` gives a deploy pipeline a hook.
- Design and trade-offs: [docs/flow-2-design.md](docs/flow-2-design.md).

### Learning from corrections (flow 2.1)

Correct Claude once. flow records the correction, finds the reusable failure behind it, and helps you prove a fix before anyone else gets it: **Capture → Understand → Improve → Prove**.

| Stage | How | Cost |
|---|---|---|
| **Capture** | `UserPromptSubmit` records corrections you type ("stop overengineering", "I said no merges", "why didn't you query the real data?"), and praise. `SessionEnd` derives counts from the local transcript: failing-test streaks, repeated commands, "done" with no test after the last edit. | No model calls; ~10–30 ms per prompt (measured) |
| **Understand** | A deterministic worker clusters incidents by (category, owning skill section or rule). It writes a dossier per cluster, with a synthetic description and no engineer text. | Local |
| **Improve** | `/flow:learn <cluster>`, run explicitly. It finds the root cause, an independent subagent writes regression cases (with held-out phrasings and bypass attempts), then the smallest fix is made in allowed files only. | Your session's tokens |
| **Prove** | `flow-learn prove`. Enforcement runs the real hooks from the baseline and the candidate. Behavior runs `claude -p --plugin-dir` (real skill loading) N times per arm, and only with `--approve-spend --budget-usd`. | Free / budgeted |
| **Propose** | One draft PR per cluster, only after the gate says `enforced` or `improved`. Rate-limited, synthetic text only. Never merged by the tool. | — |

The effectiveness gate requires all of these:
- the baseline reproduces the failure;
- the scorer separates its known-good and known-bad end states;
- the held-out phrasing improves beyond noise (90% interval);
- no other case regresses;
- tokens and skill size stay within budget;
- results come from real plugin loading.

Anything else is `cannot-reproduce`, `inconclusive`, `regressed` or `not-run`, and becomes a local review-only proposal.

**Privacy:**
- Only prompts an engineer typed are captured: Claude Code's `source: "user"`, or an attended session. `/loop`, SDK, headless and eval runs never count.
- A field containing a secret is dropped, not redacted. Tool arguments, files and diffs are never stored.
- Everything stays local (`~/.claude/flow-feedback`, mode 0600, 30-day retention), with a one-time notice.
- `flow-learn status | inspect | delete | disable` are the engineer's controls; the hooks refuse to let an agent use them or touch the store.
- A repo can require opt-in with `"learn": {"capture": "opt-in"}` in `.flow/config.json`.
- There is no team aggregation yet: lessons reach the team only as reviewed PRs.

**Safety boundaries:**
- An improvement may change only skills, `templates/rules.md`, constraint rules (data) and regression cases. `propose` refuses gates, hook code, its own harness, workflows and config.
- Its `gh` wrapper can't merge, approve, mark ready or write to the API.
- Session constraints ("don't merge") are enforced by the Bash guard on a best-effort basis; GitHub's required checks remain the hard layer.

```bash
node plugins/flow/learn/cli.mjs report            # what flow learned, every number labelled measured/estimated/unavailable
node docs/demo/flow-2.1/run.mjs                   # three incidents end to end (no model calls)
python3 docs/demo/flow-2.1/live-capture.py        # capture inside a real interactive Claude Code session, at $0
```
Design: [docs/flow-2.1-design.md](docs/flow-2.1-design.md).

## ship: deadline mode

```bash
claude plugin install ship@yassin-skills
```
`/ship:deadline-mode <goal> by <time>`. It plans backward from a fixed deadline, cuts scope (never safety, criteria or approvals), parallelizes and never idles.

## Development

```bash
node --test 'plugins/flow/test/*.test.mjs'
```
