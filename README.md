# claude-skills

```bash
claude plugin marketplace add YassinEldeeb/claude-skills
```

## flow: shipping with AI

```bash
claude plugin install flow@yassin-skills
```
Then, in your repo: `/flow:install`

| Command | What it does |
|---|---|
| `/flow:install` | Adds the rules, `status.md`, `decisions.md`, a PR template and a CI check to the repo |
| `/flow:investigate` | Pin down the behavior with evidence; propose acceptance criteria |
| `/flow:plan` | Simplest design, prior art, attacked by an independent reviewer |
| `/flow:build` | Build to the failing tests, inside the approved boundaries |
| `/flow:review` | Independent, adversarial review with evidence |
| `/flow:ship` | PR with evidence, CI, merge, deploy, verify live |
| `/flow:orchestrate` | Optional: coordinate several builders for long unattended runs |

**Autonomy contract:** 🟢 do it · 🟡 log it in `decisions.md` · 🔴 ask first (architecture, product behavior, security/privacy, weaker criteria, big cost, irreversible).

| Enforcement | How |
|---|---|
| **Hook** (plugin, best effort) | Each session starts with `status.md`, unsettled 🔴 decisions and unapproved drift · `gh pr merge` is refused while one is open (fails open if the hook crashes) |
| **CI** (`flow` check, hard gate once required) | Fails on an unsettled 🔴, unapproved drift, an empty PR template, or "needs a human" without the `human-approved` label |
| **Usage guard** (plugin) | Idle over 1 h with a big context → blocks the next message once and suggests `/compact` (the cache expired, so it would re-pay everything) · over 500k tokens → warns |
| **Advisory** | The rules in CLAUDE.md / AGENTS.md |

Make `flow` a required check in branch protection, and add CODEOWNERS on `.github/flow/**`, `decisions.md` and `status.md` so a PR can't approve its own gate.

## ship: deadline mode

```bash
claude plugin install ship@yassin-skills
```
`/ship:deadline-mode <goal> by <time>`
