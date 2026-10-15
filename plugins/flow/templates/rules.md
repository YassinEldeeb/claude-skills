## How agents work here (flow)

- **Done** = agreed behavior works + relevant tests pass + no open blocking risk + deploy verified. Green tests alone isn't done.
- **Before a substantial build:** confirm the behavior (ask only what's ambiguous) and get the acceptance criteria approved.
- **Autonomy:** 🟢 decide and do · 🟡 log in `decisions.md` and continue · 🔴 stop and ask: architecture, product behavior, security/privacy, weaker acceptance criteria, big cost, anything irreversible. A 🔴 row is not approved until a human says so. Never write an approver's name or add the `human-approved` label yourself; only record an approval a human gave you in this session.
- **Drift:** keep `status.md` (Approved / Building / Deployed / Changed) current. Every "Changed" line ends with `approved by: <name>` once a human approved it.
- **Never silently change models or providers.** Every number you report names its source, model and date.
- **Review:** independent review for non-trivial changes; human approval for high-risk ones. Auto-merge only explicitly authorized, low-risk changes with green CI, a clean review and no open 🔴.
- **Talk to humans:** action first, 3 lines, casual.
- Workflows: `/flow:investigate` → `/flow:plan` → `/flow:build` → `/flow:review` → `/flow:ship`.
- Keep this section short: when adding a rule, merge or remove an old one.
