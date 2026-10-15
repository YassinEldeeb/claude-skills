---
name: install
description: Install the flow workflow into the current repository (rules, status.md, decisions.md, PR template, CI check). Use when the user runs /flow:install or asks to set up "Shipping with AI" in a repo.
---

# Install flow into this repo

The templates live in `../../templates/` relative to this skill's base directory.

1. **Inspect first.** Read the existing CLAUDE.md / AGENTS.md, `.github/` (PR templates, workflows), hooks and conventions. Reuse what's there; never weaken an existing check or protection.
2. **Rules.** Append `templates/rules.md` to `CLAUDE.md` (and to `AGENTS.md` if the repo has one). Create the file if missing; never overwrite. Skip it if a "How agents work here (flow)" section already exists.
3. **State files.** Copy `templates/status.md` and `templates/decisions.md` to the repo root, unless they exist. Fill status.md's Goal and Approved from what you know; leave `<…>` placeholders otherwise.
4. **PR template.** If `.github/PULL_REQUEST_TEMPLATE.md` exists, add the three flow sections to it; otherwise copy `templates/github/PULL_REQUEST_TEMPLATE.md`.
5. **CI check.** Copy `templates/github/flow-lib.mjs` → `.github/flow/lib.mjs`, `templates/github/flow-check.mjs` → `.github/flow/check.mjs` and `templates/github/workflows/flow.yml` → `.github/workflows/flow.yml`. Prove it locally: run `node .github/flow/check.mjs` with `PR_BODY` set to a filled template (passes). Then, in a temp copy of the repo (never the real files), add an open 🔴 row and run it again (fails). Leave nothing behind.
6. **Recommend CODEOWNERS** on `.github/flow/**`, `.github/workflows/**`, `decisions.md` and `status.md`, so a PR can't quietly approve its own gate.
7. **Don't change** branch protection, repo permissions, auto-merge settings or production infrastructure. Recommend them instead.

## Report (short)

| | |
|---|---|
| **Hard gate (once required in branch protection)** | The `flow` CI check: unsettled 🔴, unapproved drift, empty PR template, "needs a human" without the `human-approved` label |
| **Best effort (Claude Code only)** | The plugin hook blocks `gh pr merge` on the same conditions; it fails open if it crashes |
| **Advisory** | Everything in the rules section (agents follow it, nothing forces it) |
| **Human steps** | Make `flow` a required check · require 1 review · create the `human-approved` label · add CODEOWNERS |
| **Verify** | Open a PR with an empty template → `flow` fails; fill it → passes |

List the files you created or changed.
