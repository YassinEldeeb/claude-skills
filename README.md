# claude-skills

```bash
claude plugin marketplace add YassinEldeeb/claude-skills
```

## flow: shipping with AI

```bash
claude plugin install flow@yassin-skills
```
Then, in your repo: `/flow:install`.

**One command.** In a repo with flow installed:

```
/flow:start <what you want>
```

That's the whole interface. flow sizes the risk (small / medium / high) and runs every step itself. It comes back to you only when it needs you:

1. **Spec approval** (high risk only): the outcome, design, capacity forecast and safety boundaries on one screen, before code.
2. **A decision only you can make**: a product, privacy or cost call, or a plan that won't meet your target. It brings a recommendation and keeps working on everything that doesn't depend on the answer.
3. **Ship approval** (high risk only): what works, what's verified, what's unknown, before merge.

A typo ships with no ceremony. Later prompts on the same branch pick the task up where it is: you don't type `/flow:start` again, and flow never hands you a flow command to run, except an approval only you can give.

**What it tells the agent to do on the way.** These are instructions meant to catch the expensive mistakes early. They're checked only on small synthetic repos with a stand-in model client, not in production (results in `docs/flow-2.2-design.md`):

- **Proves the risky part first.** Before building broadly, it runs the shape it plans to build on a real sample (real data, production's model and settings), measures time and cost, and forecasts the whole workload against your target. A plan that misses comes back as plan B, before the code exists.
- **Shows you a real result early.** Before broad work it names the smallest real example that exercises the risky part, and what you'll inspect: a before/after, an output, a screenshot, a command. It takes that one example through the real system first (every outside dependency wired and checked), aiming for a first checkpoint in 15 to 30 minutes. One builder until that works.
- **Keeps a trail, keeps going.** Each checkpoint appends a short round to `.flow/tasks/<ID>/progress.md` (goal, artifact, result, the same three or fewer numbers, next). It tells you in a line and carries on; it doesn't ask whether to continue.
- **Stops and rethinks.** The same kind of bug fixed twice, two rounds off-track, or a forecast that misses the deadline means no more code until there's a better plan.

**Repos with their own release policy.** In a repo without the flow gate (no `.flow/config.json`), `/flow:start` runs the same steps, and the repo's written policy (AGENTS.md / CLAUDE.md) decides approvals and merges: if it already allows agents to merge when green, or to admin-merge, flow doesn't ask again. Install the gate only where you want human `spec@`/`ship@` approvals on high-risk work; with the gate installed, nothing merges past a red `flow` check and agents never use `--admin`.

Other commands, when you want them:

| Command | What it does |
|---|---|
| `/flow:status` | Where each task really is: built → tested → integrated → merged → deployed → authorized, plus the last round's scorecard |
| `/flow:install` | Installs or upgrades flow in a repo (also migrates flow 1.x) |
| `/flow:learn` | Turns a recurring correction into a proven skill improvement (explicit only) |

Under the hood, `/flow:start` runs these steps itself (they don't appear in the `/` menu):

| Step | What it does |
|---|---|
| `challenge` | Production evidence, a measured run of the risky part, the 7 design questions, alternatives, capacity and cost ("could we drop 80% of this?"), an independent attack |
| `build` | The walking skeleton first, then failing tests inside the approved spec |
| `verify` | Independent check of behavior, safety invariants, integration and eval validity |
| `ship` | PR with evidence, gate green, merge, deploy through the pipeline, verify live |
| `orchestrate` | Several builders on dependent tasks, after the skeleton works: contracts first, one verified release |

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

### Auto-learn: it fixes itself from your rage (flow 2.3)

Type **`flow auto-learn on`** once, in any prompt. From then on, a correction you type ("stop overengineering", "why didn't you ask me first?!", "what have you been doing for 2 hours?!") starts flow's learning loop in the background, with no command to run:

1. **Waits** until that session has been idle for 10 minutes (or has ended), so it never competes with your work.
2. **Catches what the word list missed:** a Haiku pass over the session's typed prompts labels the frustration it didn't recognize.
3. **Analyzes:** a fresh agent reads the threads where it happened and writes a synthetic description of the failure and its root cause. None of your words, code or names leave that step.
4. **Writes the test independently:** a second fresh agent, given only that description, writes the regression case.
5. **Fixes:** a third makes the smallest change, in skills, rules or constraint rules only.
6. **Proves:** the real harness runs the current flow against the fix (behavioral runs 4 at a time).
7. **Opens a draft PR** only when the verdict is `improved` or `enforced`. A fix that doesn't prove is dropped and logged.

Your next session opens with one line saying what it did, for example `auto-learn since you were last here: overengineering--overengineering: PR https://github.com/...`. Point a review agent at the PR to merge it, and everyone using flow gets the fix.

- **Cost:** it runs headless Claude on your own plan (a Max plan has no extra charge). It uses some of your quota, which is why it waits for idle time and is capped at 3 attempts a day, with a 24-hour cooldown per kind of failure.
- **Control:** `flow auto-learn off` turns it off. Agents can't switch it (the guard refuses `flow-learn auto on/off`). `flow-learn auto status` shows recent attempts.
- **Limits:** it acts only on failures the skills or constraint rules can fix, never on personal preferences. Proof runs on small synthetic cases, so a proven fix is evidence, not a guarantee. Off by default for everyone but the people who turn it on.

### Learning from corrections (flow 2.1)

Correct Claude once. flow records the correction, finds the reusable failure behind it, and helps you prove a fix before anyone else gets it: **Capture → Understand → Improve → Prove**.

| Stage | How | Cost |
|---|---|---|
| **Capture** | `UserPromptSubmit` records corrections you type ("stop overengineering", "I said no merges", "why didn't you query the real data?"), and praise. `SessionEnd` derives counts from the local transcript: failing-test streaks with no code change in between, repeated non-routine commands, "done" with no test after the last edit. | No model calls. Measured inside the hook: 10–30 ms. Node's own startup comes on top; a reviewer measured 79–367 ms wall time on a heavily loaded laptop. |
| **Understand** | A deterministic worker clusters incidents by (category, owning skill section or rule). It writes a dossier per cluster, with a synthetic description and no engineer text. | Local |
| **Improve** | `/flow:learn <cluster>`, or automatically with auto-learn on (above). It finds the root cause, an independent subagent writes regression cases (with held-out phrasings and bypass attempts), then the smallest fix is made in allowed files only. | Your session's tokens |
| **Prove** | `flow-learn prove`. Enforcement runs the real hooks from the baseline and the candidate. Behavior runs `claude -p --plugin-dir` (real skill loading) N times per arm, and only with `--approve-spend --budget-usd`. | Free / budgeted |
| **Propose** | One draft PR per cluster, only after the gate says `enforced` or `improved`. Rate-limited, synthetic text only. Never merged by the tool. | — |

The effectiveness gate requires all of these:
- the baseline reproduces the failure;
- the scorer separates its known-good and known-bad end states;
- improvement on held-out cases the fix author never saw (≥3 fixtures, or the held-out phrasing beyond noise at 90%);
- the whole suite runs and no other case regresses;
- under 20% errored runs;
- tokens and skill size within budget;
- results from real plugin loading.

Anything else is `rejected`, `cannot-reproduce`, `inconclusive`, `regressed`, `invalid` or `not-run`, and becomes a local review-only proposal. `propose` doesn't trust a results file: it re-runs the deterministic cases itself, and matches behavioral results to the candidate's tree hash. An improvement may add new cases, but can never edit existing ones.

**What capture catches (measured on a 218-prompt labelled set written independently):**
- corrections: precision 1.00, **recall 0.21**. The lexicon catches about one correction in five, and what it catches is right;
- category accuracy is 0.18 across all labelled corrections.

Explicit corrections like the examples above are caught; implicit ones ("no, use billing") mostly aren't. `flow-learn report` prints these numbers next to every rate.

**Privacy:**
- Only prompts an engineer typed are captured: Claude Code's `source: "user"`, or an attended session. `/loop`, SDK, headless and eval runs never count.
- A field containing a secret is dropped, not redacted. Tool arguments, files and diffs are never stored.
- Everything stays local (`~/.claude/flow-feedback`, mode 0600, 30-day retention), with a one-time notice.
- `flow-learn status | inspect | delete | disable` are the engineer's controls; the hooks refuse to let an agent run `disable`, `enable` or `delete`, or touch the store. That refusal is best effort: a determined agent could find a command the patterns miss. `delete --all` keeps your capture setting.
- A repo can require opt-in with `"learn": {"capture": "opt-in"}` in `.flow/config.json`.
- There is no team aggregation yet: lessons reach the team only as reviewed PRs.

**Safety boundaries:**
- An improvement may change only skills, `templates/rules.md`, constraint rules (data) and regression cases. `propose` refuses gates, hook code, its own harness, workflows and config.
- Its `gh` wrapper can't merge, approve, mark ready or write to the API.
- Session constraints ("don't merge") are enforced by the Bash guard on a best-effort basis; GitHub's required checks remain the hard layer.
- **No constraint rules ship yet.** The engine is there, but rules arrive only as proven improvements. The demo's no-merge rule handled every command in five cases, then missed one phrasing in its fourth unseen round, so the gate rejected it ([results](docs/demo/flow-2.1/RESULTS.md)).
- Behavioral evals need spend approval, recorded from your own prompt ("approve spend up to $20"); the hooks refuse `--approve-spend` without it.
- The demo's two instruction changes (outcome drift, overengineering) were evaluated on Opus through real plugin loading (correction, flow 2.2: in those runs the plugin copy lacked `learn/`, so the hooks failed to load and the runs measured skills without hooks; see `docs/flow-2.2-design.md`): the current flow already passed every run (9/9 each), so the gate returned `cannot-reproduce` and neither change was promoted. No regressions ([behavioral results](docs/demo/flow-2.1/BEHAVIORAL.md)).

```bash
node plugins/flow/learn/cli.mjs report            # from a checkout; an installed plugin's CLI is in ~/.claude/plugins/cache/…/flow/<version>/learn/cli.mjs
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
