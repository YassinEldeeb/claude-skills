# flow 2.0: design

Status: built in this PR (flow 2.0.0, ship 1.2.0). Supersedes flow 1.1.

flow 1.x checked that agents **followed a process**: Markdown status, decision rows, no merge while a 🔴 was open. Memory v2 showed where the expensive mistakes come from: the problem definition, architecture, economics and test method were never challenged before implementation. And the 1.x gate could be satisfied by editing Markdown.

flow 2.0 aims to **stop expensive mistakes before they get expensive, and scale the rigor to the risk**. A typo does not pay for a distributed-systems review.

## 1. Architecture (the smallest credible design)

Five mechanisms. Everything else is a skill (a prompt) built on top of them.

| # | Mechanism | What it is |
|---|---|---|
| M1 | **Task spec** | `.flow/tasks/<ID>/task.json` (machine-checked, strict schema) + `design.md` (for humans). One directory per task, so parallel worktrees and PRs never share a state file. |
| M2 | **Risk rules** | `.flow/config.json` lists path globs and changed-line patterns (added *or removed*) that mark a change medium or high; some also require a capacity model. Built-in rules: changing the gate, its config or any CI workflow is high (any workflow can post checks); a file whose diff GitHub omits is high; a new top-level directory is medium. The gate classifies every PR from its diff; a builder can only *raise* the tier. |
| M3 | **One evaluator** | `evaluate()` in `.github/flow/lib.mjs`: from config, PR, diff, tasks, comments, reviews, checks and deployments to a verdict and a dashboard. The CI gate, `flow status`, `flow check` dry runs and `rollout-ok` call it. The hooks share its parsers and rules from the plugin's copy, and SessionStart warns when the two versions differ. |
| M4 | **Content-bound approvals** | A PR comment whose first line is `/flow approve <ID> <kind>@<hash>`. The kinds: `spec` (task.json minus progress fields, design.md and the challenge review, 96-bit hash); `ship` (the PR's diff against its merge base, which survives a clean "Update branch"); `override` (a lower tier or a waiver). **Signed mode**: only an SSH signature by a key in `config.signers` counts, over repo, task, kind and hash; it holds even when agents share the human's GitHub login. **Login mode**: only `config.approvers` (login or `login#id`), never `agents`, bots, the PR author (by default) or an edited comment. |
| M5 | **A gate the PR can't rewrite** | `pull_request_target` + `issue_comment` run the workflow from the protected branch. Config and dependency state are read from the default branch through the API; the PR's code never runs. A PR into an unprotected branch isn't judged. The verdict is the `flow` check run, re-posted on every push, when the repo's CI workflows finish (`workflow_run`), and on every comment mentioning `/flow`. It is never posted onto a head that moved during the check, and never for a skipped PR, since check runs belong to commits that other PRs can share. **Standard mode**: posted by GitHub Actions. **Hardened mode**: posted by the repo's own GitHub App, whose key lives in an environment limited to the protected branch. Fails closed. |

Hooks (best effort, Claude Code only):
- **SessionStart:** also fires after `/compact`. Names the branch's task, whether its code is held, its open 🔴 decisions, and a gate version mismatch.
- **PreToolUse Edit/Write:** holds code edits of a high task until its approved spec is synced (`flow sync`). Routes an edit that trips a high rule no task lists through `/flow:start`. Refuses writes to approval records.
- **PreToolUse Bash:** refuses posting or signing approvals, writing approval records, `--admin` merges, and changes to protection, rulesets, environments or Actions permissions.
- **UserPromptSubmit:** a non-blocking token warning (idle past `FLOW_CACHE_TTL_MIN` with a big context; over 500k).

## 2. Gap analysis of 1.1 (by priority)

| P | Gap | 2.0 answer |
|---|---|---|
| P0 | Approval was text an agent can type (`approved by: claude`, status `done`, the `human-approved` label) | M4: identity-checked or signed comments bound to content; names in files and labels carry no weight |
| P0 | The gate ran the PR's own copy of the check and read the PR's own state files | M5: protected-branch code and config |
| P0 | It failed open: a missing file skipped checks; a blank line or a second table disabled parsing | Strict JSON schema; every missing or unknown piece fails |
| P0 | Bot-authored PRs skipped the body checks | No author exemptions |
| P0 | One process for every change | M2 tiers from the diff, with a no-task fast path |
| P0 | No architecture, economics or assumption challenge before building | High: 7-question `challenge`, ≥2 alternatives, assumptions that state what they block, an independent review file, `capacity` with measured or estimated numbers |
| P1 | Criteria could be "memory saves correctly" | Typed criteria (kind, severity, verify), each with resolvable evidence |
| P1 | Unit tests stood in for cross-system safety | A critical safety invariant can't be `unit`/`manual`; test refs must live in the kind's configured paths, and that suite must pass |
| P1 | Raw eval failures read as product bugs | Evals count only with a gold set on the protected branch that the scorer classifies correctly; results split into product, safety, eval-defect and unknown; ≥3 runs for a critical eval; safety failures block |
| P1 | A single `status.md` collided across parallel work | M1 |
| P1 | Parallel PRs never integrated | `dependsOn` is satisfied only by the dependency's merged PR (cross-repo `owner/repo#N`); combined-system evidence and a deploy plan are required |
| P1 | Progress reported as activity | One dashboard, only stages the gate can check itself |
| P2 | The merge-guard regex missed wrappers and GraphQL | Dropped: the required check is the merge gate |
| P2 | The context guard blocked prompts and assumed a 60-minute cache | Non-blocking; the TTL is configurable |
| P2 | The repo's copy of the gate drifted from the plugin | `FLOW_VERSION`; a SessionStart warning; `/flow:install` upgrades the gate in its own PR |
| P2 | deadline-mode contradicted flow | Precedence: deadline mode cuts scope and process, never safety, criteria or approvals. Plan B is the "highest-confidence smaller scope", never "for sure" |

## 3. Enforcement matrix

Bypass resistance: **H** = needs a human's GitHub identity or signing key, or repo-admin rights. **M** = needs the agent to break a written rule *and* get past the independent reviewer or the human reading the PR. **L** = advisory or best effort.

| Requirement | Mechanism | Resistance | Test (`plugins/flow/test/`) |
|---|---|---|---|
| Tier can't be lowered by the builder | Tier = max(declared, its signals, its tier on the protected branch); lowering needs `override@` | H | `tier: *` (11 cases) |
| New risk after approval needs re-approval | Signals are in the spec hash; an unlisted detected signal blocks | H | `a detected signal no task lists blocks` |
| High spec approved by a human | `spec@` from a signer, or an approver who isn't an agent or the author and hasn't edited the comment | H signed, or login with separate agent identities; M login with a shared identity | `approvals: *` (11), `signed approvals` (real ssh-keygen) |
| High-risk changes approved as merged | `ship@` = hash of the PR's diff | H (same caveat) | `ship approval covers these exact changes` |
| The gate can't be changed by the PR it judges | Protected-branch workflow and config; built-in `flow-gate` high rule | H | `editing the gate or its config is high risk` |
| The verdict can't be forged | Hardened: App check run with an environment-scoped key, pinned source. Standard: GitHub Actions check (any workflow can post one) | H hardened; M standard (needs agents without the `workflow` scope and a read-only default token) | `flow doctor` reports the mode and settings |
| Fail closed | Missing or invalid config or task, unknown schema, truncated file list, API error → failure | H | `fail closed: *` (6) |
| Criteria are testable and traced | Schema plus evidence refs that resolve: a plain repo path, a declared test, not skipped (line or block), in the kind's paths, and the kind's configured CI check green (commit statuses count). A kind with no configured check can't prove a critical criterion | M | `evidence: *`, `fresh-eyes review fixes` |
| Cross-system safety isn't proven by unit tests | Critical safety verify ∈ {integration, e2e, failure_injection, eval}; paths per kind | M | `S3` |
| Architecture challenged before building | High: challenge + review file with `verdict: pass` (CI); the edit hook holds code until spec approval | M (CI), L (hook) | `S1`, `edit guard` |
| Economics modeled | `capacity` on capacity signals; typed keys; measured = ref + date; high needs ≥1 measured workload number | M | `S1` |
| Evals validated before gating | Gold set on the protected branch, untouched by the PR, ≥ `minGold`, scorer accuracy ≥ `minScorerAccuracy`; ≥ `minEvalRuns`; safety failures and (critical) unknowns block | M | `S2` |
| Independent verification | An approving review on the head by a `reviewBots` login, else `verify.md` | M with a review bot; **L with verify.md** (the builder can write it) | `independent verification is required`, `with review bots configured…` |
| Parallel work integrates | Dependency = its merged PR whose body names it; combined evidence; deploy plan | H (merge order), M (evidence) | `S4` |
| Outcome-based status | Stages only from checks, merge state, deployments and approvals; unknown ≠ pass | H (no agent-typed stages) | `S5` |
| No self-authorization in the session | Bash and edit hooks | L | `self-authorization guard` (12) |
| Token economy | Non-blocking guard; cheaper models for chores in the skills | L | `the context guard warns but never blocks` |

Each protection was also checked by mutation: disabling it turns at least one test red. 19 protections were checked: edited comments, agent logins, unscanned files, skipped lines and skipped blocks, the dependency's merge, unit tests for safety, removed lines, the tier floor on the protected branch, the gold set's location, the ship hash, unapproved waivers, posting for skipped PRs, path safety, cited old tasks, last-line verdicts, kinds without CI checks, workflows as gate changes, and blocker escaping.

## 4. Task lifecycle

| | Small 🟢 | Medium 🟡 | High 🔴 |
|---|---|---|---|
| Examples | Typo, isolated UI fix, plain bug | Feature, business logic, API integration, prompt change, dependency bump | Architecture, migration, background processing, auth, privacy, billing, the gate itself |
| Task file | None | `task.json` | `task.json` + `design.md` + `challenge-review.md` |
| Before build | Reproduce | Criteria + light challenge (simplest option, 2 failure modes) | Production evidence → `/flow:challenge` (independent) → capacity model → draft PR with only the spec → **checkpoint 1: `spec@`** |
| Build | Fix + test | To failing tests | To failing tests incl. failure injection; code held by the hook until the spec is approved |
| Verify | Light | `/flow:verify` (or the review bot) | Same + eval validity + integration |
| Human | Nothing | Nothing (an `override@` only to lower a tier or waive a step) | `spec@` before code; `ship@` before merge (**checkpoint 3**) |
| A boundary changes mid-build | n/a | Spec edit (high-risk signals need re-approval) | The spec hash changes and the approval lapses: **checkpoint 2** comes up on its own |

The entry point is `/flow:start <goal>`. It classifies, then runs challenge → build → verify → ship in order, stopping only at the checkpoints.

## 5. Implementation (in impact order, all in this PR)

1. **Gate core:**
   - `lib.mjs`: evaluate, schema, risk rules, hashing, approval parsing, the SSH verifier, rendering;
   - `flow.mjs`: `check`, `status`, `sync`, `token`, `classify`, `validate`, `approve`, `doctor`, `rollout-ok`;
   - the standard and hardened workflows.
2. **Templates:** the config with default risk rules, an example task, the rules, the PR template.
3. **Skills:** `start` (router), `challenge`, `build`, `verify`, `ship`, `status`, `orchestrate`, `install` (also upgrades and migrates 1.x).
4. **Hooks:** session-start, edit guard, self-authorization guard, non-blocking context guard.
5. **deadline-mode precedence;** a README with the enforcement table and the hardening steps.
6. **Tests:** 106 `node --test` cases (gate, scenarios, real hook and CLI processes, real ssh-keygen), plus CI for this repo.

## 6. Regression tests: the Memory v2 failures

`plugins/flow/test/scenarios.test.mjs` replays each failure. It must block early, then pass once the missing work exists.

| | Memory v2 failure | Blocks because |
|---|---|---|
| S1 | Backfill built before workload, cost and first-useful latency were known | The code is classified high (worker, bulk, model call) with no task. Then: no capacity model, a single alternative, no measured workload number. Then: an unverified assumption marked `blocks: merge`. Marked `blocks: rollout`, it merges for an internal canary but `rollout-ok` refuses. |
| S2 | Eval failures conflated with product defects | No gold set; a gold set that's too small, wrong, missing from the protected branch, or changed by the PR; one run; a safety failure; unattributed results. Attributed quality failures alone pass, and the dashboard shows product and eval defects separately. |
| S3 | Unit tests passed while real fenced publication broke | A critical safety invariant verified by `unit` is rejected; a unit test relabeled `failure_injection` is rejected by path; a real fault test passes. |
| S4 | Parallel PRs never integrated or deployed together | A dependency not merged; a spec-only dependency whose PR isn't merged; a PR that isn't the dependency's; no combined evidence; no deploy plan; an unreadable or unmerged cross-repo dependency. |
| S5 | Reports showed activity, not outcomes | Merged ≠ deployed: `deployed` stays unknown without a GitHub deployment of the merge commit, and an agent's "released" comment changes nothing. Canary criteria show as open. Running CI shows as running. |

## 7. Trade-offs and remaining limits

- **Standard mode can be forged by a deliberately malicious agent with write access.** It can add a workflow that posts a `flow` check, or rerun an old run from a retargeted base. That needs `workflow` scope and a writable token, so deny both. Only hardened mode (an App key that only the protected-branch job can read) closes this. `flow doctor` says which mode a repo runs.
- **Shared credentials cap login mode.** If agents use the human's GitHub token, they can post approvals as that human. Signed mode closes this as long as agents can't use the signing key. A key that needs a touch is the real separation on one machine.
- **The gate checks completeness and references, not quality.** It can prove a critical criterion points at an existing, unskipped test whose suite passed. It can't prove the test is meaningful, the design good or the numbers true. Those rest on the independent reviewers and the human at checkpoint 1. `verify.md` is self-attested (L) unless a review bot is configured.
- **Agent-reported numbers:** capacity numbers and eval counts are written by the agent. The gate demands sources, dates, run counts and a gold set on the protected branch, and shows them on the approval card. Reading eval results from CI artifacts is the next step.
- **"Before implementation" is local:** CI can't know when code was written; the edit hook holds code edits, best effort.
- **Risk rules miss things and misfire:** the defaults are a starting point that `/flow:install` tailors. Misses fall back to the builder's tier, the new-module and size floors, and review. False positives cost one task file (medium) or one approval (high).
- **Stale verdicts:** a verdict can go stale when the base moves. Require branches to be up to date (the doctor checks it); a scheduled re-evaluation of open PRs isn't built.
- **Merge queues:** `merge_group` reports success, because each PR passed the gate before queueing. Combined-system tests belong to the repo's own merge_group CI.
- **Upgrades:** the old gate judges the upgrade PR (high risk, approval needed). Change the task schema only after the new gate is live.
- **Signed approvals aren't bound to a PR number.** One could be copied to another PR whose task has byte-identical content; the content binding limits the harm.
- **Not built:** per-task token accounting, detection of overlapping open PRs, deploy verification beyond GitHub deployment records, JUnit-level proof that a named test ran, and a live sandbox-repo end-to-end test of the GitHub mechanics (see the PR).

## 8. Adversarial review: findings and resolutions

An independent reviewer attacked the first draft of this design (6 blockers, 18 majors, 12 minors). Each finding and what changed:

| # | Finding | Resolution |
|---|---|---|
| B1 | Any workflow can post a `flow` check as GitHub Actions; pinning the source doesn't stop it | Two honest modes. Hardened = your App with an environment-scoped key. Standard is labeled M and needs a read-only token and no `workflow` scope. The job was renamed `flow-gate`, so its own run never shows as `flow`. |
| B2 | Write users can edit a human's approval comment | Login mode ignores edited comments; deletes and edits re-trigger the gate. Signed mode makes the poster irrelevant. |
| B3 | With a shared identity every "H" is honest-agent | Signed approvals (`ssh-keygen -Y`). The dashboard states the approval mode; the doctor flags a shared approver login. |
| B4 | An unscannable diff downgraded high to medium; deletions and renames escaped | Unscannable → high. Line rules scan removed lines. Path rules check both names of a rename. A new top-level directory → medium. Lockfiles → medium. |
| B5 | Retargeting the base runs a different gate and config | Config and dependencies are read from the default branch. Only `branches` are judged. Hardened mode's key is unavailable to other branches. Standard mode's residual risk is documented. |
| B6 | Evidence was self-attested (skipped tests, mislabeled kinds, any CI check) | Skip and comment detection; per-kind `paths` and `checks`; the kind's suite must pass on the head. JUnit artifacts are left as a next step. |
| M7 | `issue_comment` runs from the default branch; a TOCTOU race on the head | The verdict is posted explicitly as a check run on the head read, and dropped if the head moved. One concurrency group per PR. |
| M8 | Stale verdicts after base moves; merge_group pass-through | Doctor requires up-to-date branches; merge_group documented. |
| M9 | "dependsOn on base" was satisfied by a spec-only merge | A dependency counts only via its merged PR, which must name it; cross-repo `owner/repo#N`. |
| M10 | Eval triage and gold set were agent-controlled | Gold set on the protected branch and untouched by the PR, minimum size, scorer accuracy, ≥3 runs for critical evals, unknowns block critical evals; results can name a CI check. |
| M11 | The review file is self-written | `reviewBots` lets a bot review count; `verify.md` is labeled L. |
| M12 | "Measured" capacity was unverifiable and untyped | Typed keys (`users`, `workPerUser`, `firstResult`, `perUser`), measured = ref + date, shown first on the approval card; spikes before checkpoint 1 in `/flow:challenge`. |
| M13 | No task meant small | New-module and 500-line floors; the edit hook routes high-risk edits through `/flow:start`. |
| M14 | Medium was bureaucratic and gave false confidence | Medium needs no human: evidence plus verification only. |
| M15 | `ship@` bound to the head sha breaks on "Update branch" | `ship@` binds to the diff hash; up-to-date branches recommended. |
| M16 | Hash scope undefined; short hash grindable | Explicit progress fields excluded; assumptions are in the spec; 96-bit hash. |
| M17 | Delete, rename or edit of other tasks | Every touched task is evaluated; deleting or renaming a task blocks; the tier on the protected branch is a floor. |
| M18/19 | Rollout authorization and stages were agent-reported | `/flow release` was dropped. Stages come only from checks, merges and GitHub deployments; `rollout-ok` is for pipelines. |
| M20 | Approval parsing matched quotes and prose | First line only. |
| M21 | Admin and ruleset bypass | The doctor checks enforce-admins and notes bypass lists; the Bash hook refuses `--admin`. |
| M22 | Only evaluate() fixtures | Real processes for hooks and CLI, real ssh-keygen, mutation checks. A live sandbox-repo test of GitHub mechanics is still to run (see the PR). |
| M23 | Classification came too late | The edit hook classifies each edit; SessionStart routes to `/flow:start`. |
| M24 | Upgrade deadlock on schema versions | The gate upgrade ships in its own PR before any schema change. |
| m25–m35 | Re-runs, Bash writes, version drift, logins, Markdown injection, override visibility, overlapping PRs, deadline waivers, production access, decisions, comment filtering | Config read through the API at run time; Bash writes labeled L; versions surfaced; `login#id`; all task text escaped; override shown as a banner and its own verb; overlapping PRs not built (limit); typed `waivers` need approval; the challenge skill names the human-export path; decisions are typed in task.json; the job's `if` filters comments |
| 36 | Use native reviews, not comment parsing | Not adopted as the default: native reviews can't separate a human from an agent that shares their login (the owner's setup), and GitHub forbids self-approval. Signed comments can. `reviewBots` adopts native reviews where a separate bot identity exists. |

## 10. Live verification (real GitHub, 2026-10-16)

A private throwaway repo ran the gate from this PR with a ruleset requiring `flow` from GitHub Actions (no bypass actors). The results are in the README's "Verified on real GitHub" table. Defects found and fixed in this PR:
- The escaping put a zero-width space inside `spec@<hash>`: a hash copied from the table failed silently, and the blocker's code span broke. Only mention-shaped `@` is neutralized now.
- A `workflow_run` judged only the first PR it lists. It now judges every one.
- `cancel-in-progress: true` cancelled gate jobs and turned the PR's rollup red. Runs now queue.

Observed GitHub behavior, now documented: a commit that was also the head of a PR into another branch stops satisfying the required `flow` check for its merge into main (3 of 3 times). It fails safe, and the dashboard points to the fix (a new commit). Hardened mode was not tested (no GitHub App available).

## 9. Fresh-eyes review of the build: findings and fixes

A second independent reviewer audited the built diff (25 findings). The material ones:

| Finding | Fix |
|---|---|
| A PR into an unprotected branch posted a passing `flow` check on a commit another PR to main shares | A skipped PR posts nothing (`checkToPost`) |
| Workflow-level concurrency let comment runs that the `if:` skips cancel real gate runs | Concurrency is at the job level |
| `..` in evidence or gold-set paths reached other API endpoints (an issue body counted as a test) | `safePath` on every path taken from task data |
| An old merged task could be cited to cover a new PR | A cited task must be changed by the PR or have `pr` set to it |
| Task text inside blockers rendered raw (mentions, links, table breaks, autolinked URLs) | `render` escapes every blocker, unknown and cell as a whole line; only the gate's own approval code spans are restored |
| Any line saying "verdict: pass" counted | Only the last non-empty line counts |
| Renames, empty files and binaries (no patch) counted as unscanned, so high | Unscanned only when the file has changes GitHub didn't show |
| "Its suite must have passed" held only if the config named checks | A kind with no configured CI check can't prove a critical criterion; commit statuses count as checks |
| Skip detection was per line; a name in an assertion message counted | A test must be declared by a test call or test function; skipped blocks fail; `.only` is not a skip |
| The gate never re-ran when CI finished | A `workflow_run` trigger; the ship skill says to comment `/flow` |
| Workflow changes were only medium, though any workflow can post checks | `.github/workflows/**` and `.github/actions/**` are in the built-in `flow-gate` rule; the doctor and README name the `workflow` scope as what stops forgery, not the default token |
| The hardened mode's own environment made merged PRs look deployed | `flow-gate` deployments are ignored; a merge-queue note was added to the App setup |
| Ship hash included context lines | It hashes changed lines only |
| Bash guard bypasses (`-Ysign`, `--method=PUT`, implicit POST with `--input`, `\` continuations) and false refusals (commit messages, `cat`) | Tightened, with tests for each |
| `.flow/config.json` edits skipped the edit hook's risk check | Only `.flow/tasks/` is exempt |
| A medium task with only normal criteria passed with no evidence | Medium and high need at least one critical criterion |
| Quoted file names and removed `-- ` lines broke the diff parser | Fixed, with a test |
| Dashboard update could patch another bot's comment or duplicate after an error | Comments are listed fresh; a failed PATCH falls back to a new comment |
