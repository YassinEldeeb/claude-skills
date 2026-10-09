---
name: deadline-mode
description: Use when the user sets a hard deadline ("/deadline-mode X by 3pm") or says a task must ship today. Plans backward from the deadline, cuts scope, parallelizes, never idles.
---

# Deadline mode

The user gives a goal and a deadline (e.g. `/deadline-mode memory v2 live for Flo by 15:00`). If no deadline was given, ask for one in a single line, then start.

**The deadline is fixed.** Never move it, and never answer with "tomorrow", "next week", "by Friday" or "Monday". Negotiate scope, not the date. If the deadline truly can't be met, say exactly what scope fits and what has to be cut.

## Rules

1. **Redesign for the deadline.** If the current plan can't make it, don't just go faster: find a simpler path. Ask what already exists that can be reused instead of built. Show plan A (the current plan) against plan B (the one that fits the deadline), and say what B drops.
2. **Fallback ladder.** Rung 1 is something real the user can show or use no matter what, and it gets done first. Higher rungs are better versions, built in parallel. Never depend on one fragile path.
3. **Parallelize.** One driver coordinates. Builders work in separate worktrees, one PR each, merged in order. If sessions can stall, keep a watchdog that resumes them.
4. **Hidden queues audit.** List everything that's waiting: CI, reviews, deploy windows, locks, approvals, evals, rate limits. For each one, give how long it takes and how to remove it, shorten it or run it in parallel. Check for silent queues too, such as CI that only runs on some branches, or jobs waiting behind long evals.
5. **Never idle.** Blocked for more than 15 minutes means writing down the exact unblock. Unblock it yourself if you safely can; otherwise move to the next item and come back.
6. **Review loop.** A fresh-eyes subagent reviews every diff before it's pushed. Fix review findings within minutes, reply to each point with the fixing commit, and re-request review.
7. **Decisions.** Put anything ambiguous in a list of at most 5, each with your recommendation. Don't guess silently and don't wait: keep working on everything that doesn't depend on the answer.
8. **Report in outcomes, not activity.** Every update says what is merged, green or deployed, what's waiting on whom, and what changed since the last update. No running commentary.

## First reply, before doing any work

1. A table of 30-minute slots until the deadline. Each row says what is DONE at the end of the slot (merged / green / deployed, never "in progress"), and whether it's real work or waiting.
2. Plan A vs plan B, and what B drops.
3. The hidden queues audit.
4. The decision list, with recommendations.

Then start immediately on rung 1. Don't wait for approval of the plan unless a decision blocks rung 1.
