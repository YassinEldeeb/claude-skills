# Project rules

## How agents work here (flow)

- **Start every non-trivial task with `/flow:start`.** It classifies the risk (small / medium / high) and runs every step itself, coming back only at a human checkpoint. Small changes skip the ceremony. Never hand the engineer a flow command to run next; run that step (approvals excepted: only a human gives them).
- **Prove it first, show it often:** run the risky part on real data before building broadly, build the thinnest real end-to-end path next, and end every milestone with something the engineer can see plus the same ≤3 outcome numbers (`.flow/tasks/<ID>/progress.md`).
- **Two strikes, then rethink:** the same kind of bug fixed twice, two rounds off-track, or a forecast that misses the deadline means stop adding code and bring plan B as a 🔴 decision.
- **Done** = the agreed behavior works in the deployed system, with evidence, its failure paths included (`/flow:start` §4). Merged is not done; green tests are not done.
- **Never claim what the code doesn't do:** no "retrying in a few minutes", ETA or background job that doesn't exist. When something fails, say what failed and hand over the best fallback.
- **Tasks live in `.flow/tasks/<ID>/`** (`task.json` + `design.md`). One task per piece of work; the PR body says `Flow-Task: <ID>`. Never edit another task's files.
- **Autonomy:** 🟢 decide and do · 🟡 note it in the task's `log` and continue · 🔴 stop and ask: architecture, product behavior, security/privacy, weaker acceptance criteria, big cost, anything irreversible. A 🔴 goes in `decisions` with a recommendation; keep working on what doesn't depend on it.
- **Approvals come only from humans,** as `/flow approve …` PR comments that the gate checks against the base branch's approvers. Never post one, never write `.approved` files, never merge with `--admin`, never touch branch protection.
- **Changing an approved spec** (criteria, design, decisions, signals, tier) voids its approval. Change it openly and ask again; never weaken criteria quietly.
- **Evidence over claims:** every number names its source, model and date; never switch models or providers silently; an eval counts only after its scorer passes the gold set.
- **Usage:** a cheaper model for chores (watching CI, reviews of small diffs, deploy checks); keep each session under ~500k context; write state to the task before compacting.
- **Talk to humans:** action first, 3 lines, casual. Report outcomes (built → tested → integrated → merged → deployed → verified), not activity.
- **Deadline mode** (`/ship:deadline-mode`) may cut scope and process, never safety, approvals or acceptance criteria.
