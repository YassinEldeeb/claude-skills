---
name: install
description: Install or upgrade flow in the current repository (gate, config, PR template, rules), including migrating a flow 1.x repo. Use when the user runs /flow:install or asks to set up flow or "Shipping with AI" in a repo.
---

# Install (or upgrade) flow

The files live in `../../gate/` and `../../templates/`, relative to this skill's directory. Work in a branch and deliver one PR. Never change branch protection, repository settings or production infrastructure: recommend them.

## 1. Inspect

- Read CLAUDE.md / AGENTS.md, `.github/` (workflows, PR template, CODEOWNERS), the test layout, the CI job names, and where migrations, auth, billing, workers and prompts live.
- Reuse what is there. Never weaken an existing check.

## 2. Ask the human (🔴: this decides who can approve)

One message, with your recommendation:
- **Who approves?**
  - *Signed mode* (recommended when agents use a human's GitHub login, which is common): `signers` with each approver's SSH public key. A key that needs a touch (Secure Enclave, a YubiKey, the 1Password agent) keeps agents on the same machine from signing.
  - *Login mode:* `approvers` as GitHub logins, plus `login#<numeric id>` from `gh api users/<login>`. Only hard when agents have their own GitHub identity, listed in `agents`.
- **Which mode for the check?**
  - *Standard:* GitHub Actions posts `flow`.
  - *Hardened:* your own GitHub App posts it, with its key in an environment limited to the protected branch (`flow-hardened.yml` explains the setup).
- **Review bots** (`reviewBots`), if the repo has one whose approving review should count as the independent verification.

## 3. Files

- `../../gate/lib.mjs` → `.github/flow/lib.mjs` and `../../gate/flow.mjs` → `.github/flow/flow.mjs`.
- `../../templates/github/workflows/flow.yml` (or `flow-hardened.yml`) → `.github/workflows/flow.yml`. Set its `workflow_run.workflows` to this repo's CI workflow names, so the gate re-runs when CI finishes and CI checks can count as evidence.
- `../../templates/config.json` → `.flow/config.json`, tailored to this repo:
  - approvers or signers, and agents;
  - `branches`: the protected branches;
  - `risk` paths matching where migrations, auth, billing, workers and prompts actually live; drop rules that can't apply, add repo-specific ones;
  - `verify`: for each kind (unit, integration, failure_injection, e2e), the test paths and the CI check names that run them. Until a kind names a check, its tests can't prove a critical criterion: the gate can't see that the suite ran;
  - `ignore` and `codeFiles` for the languages in use.
- **The PR template:** add the `Flow-Task:` line and the `## Evidence` section to `.github/PULL_REQUEST_TEMPLATE.md`, or copy `../../templates/github/PULL_REQUEST_TEMPLATE.md`.
- **The rules:** add `../../templates/rules.md` to CLAUDE.md, and to AGENTS.md if it exists. Replace an older "How agents work here (flow)" section rather than adding a second one.
- **.gitignore:** add `.flow/tasks/*/.approved`.
- Create `.flow/tasks/` with a `.gitkeep`.

## 4. Upgrading

- **From flow 2.x:** replace only `.github/flow/*` and the workflow, in a PR of their own, with no task-schema changes in the same PR. The old gate judges the PR, and changing the gate is high risk (`flow-gate`).
  - Give the PR a task: tier `medium`, signals `["flow-gate"]`, criteria such as "the gate's tests pass" with `ci:` evidence.
  - Ask the human for the `override` approval it needs; never ask for less.
- **From flow 1.x** (`status.md`, `decisions.md`, `.github/flow/check.mjs`):
  - move open 🔴 rows and unapproved "Changed" items into one task;
  - delete those files and the 1.x check;
  - say so in the PR.

## 5. Prove it

- `node .github/flow/flow.mjs validate` passes once approvers or signers are set.
- After opening the PR, `node .github/flow/flow.mjs check --pr <N> --config .flow/config.json` shows what the gate will say. Before the merge no gate runs at all: the workflow isn't on the protected branch yet.
- The install PR itself is not judged by the gate (it isn't on the protected branch yet): a human reviews it.

## 6. Report: what enforces what, and the human's steps

| Layer | Strength | What |
|---|---|---|
| `flow` check, required | Hard, once settings below are done | Tier from the diff; spec, evidence, eval, dependency and approval checks; fails closed |
| GitHub settings | Hard | Required check pinned to its source, up to date before merge, no admin or ruleset bypass for agents |
| Signed approvals | Hard even with a shared GitHub login | Only a listed SSH key can approve |
| Hooks | Best effort | Hold high-risk code until the spec is approved; refuse self-approval, `--admin` and protection changes |
| Rules in CLAUDE.md | Advisory | Everything else |

**Human steps after merge:**
1. Make `flow` a required check, with GitHub Actions (or the App) as its source.
2. Require branches to be up to date.
3. Turn on enforce admins, and remove agents from bypass lists.
4. Set the default workflow token to read-only.
5. Give agents a token without admin or `workflow` scope.
6. Then run `node .github/flow/flow.mjs doctor`.

List the files you created or changed.
