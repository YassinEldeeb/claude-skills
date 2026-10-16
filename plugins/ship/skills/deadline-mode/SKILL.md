---
name: deadline-mode
description: Use when the user sets a hard deadline ("/deadline-mode X by 3pm") or says a task must ship today. Plans backward from the deadline, cuts scope, parallelizes, never idles.
---

# Deadline mode

The user gives a goal and a deadline (e.g. `/deadline-mode memory v2 live for Flo by 15:00`). If no deadline was given, ask for one in a single line, then start.

**The deadline is fixed.** Never move it, and never answer with "tomorrow", "next week", "by Friday" or "Monday". Negotiate scope, not the date. If the deadline truly can't be met, say exactly what scope fits and what has to be cut, and say it as early as you know it.

**What a deadline can and can't cut.** Deadline mode cuts scope and process overhead: optional features, extra docs, ceremony around small work. It never silently:
- weakens a safety invariant, an acceptance criterion or an approved product behavior;
- swaps a required real-service check for a mock;
- skips a required human approval;
- calls an unverified deploy done.

In a repo that uses flow, those rules win over speed. Cutting a required step (a capacity model, a challenge, a verification) is a flow waiver, and it needs a human's approval like any other. A smaller safe outcome on time beats a bigger unsafe one.

## Rules

1. **Redesign for the deadline.** If the current plan can't make it, don't just go faster: find a simpler path. Ask what already exists that can be reused instead of built. Show plan A (the current plan) against plan B (the highest-confidence smaller scope that fits), with B's remaining risks and what it drops. No estimate is certain; never present one as if it were.
2. **Fallback ladder.** Rung 1 is something real the user can show or use no matter what, and it gets done first. Higher rungs are better versions, built in parallel. Never depend on one fragile path.
3. **Parallelize.** One driver coordinates. Builders work in separate worktrees, one PR each, merged in order. If sessions can stall, keep a watchdog that resumes them.
4. **Hidden queues audit.** Find everything that's waiting: CI, reviews, deploy windows, locks, approvals, evals, rate limits. For each, give how long it takes and how to remove it, shorten it or run it in parallel. Check for silent queues too, such as CI that only runs on some branches, or jobs waiting behind long evals.
5. **Never idle.** Blocked for more than 15 minutes means writing down the exact unblock. Unblock it yourself if you safely can; otherwise move to the next item and come back.
6. **Review loop.** A fresh-eyes subagent reviews every diff before it's pushed. Fix review findings within minutes, reply to each point with the fixing commit, and re-request review.
7. **Decide, don't ask.** Make every call you can and state it in one line ("Decided: X, because Y"). Only ask the user about things that are irreversible, cost money, need someone else's permission, or would weaken safety, criteria or approvals: at most 3, each with your recommendation. Keep working on everything that doesn't depend on the answer.
8. **Human waits get a ready ask.** Every wait on a person (a review, an approval, a login) comes with the exact message or command to send, ready to paste, and the latest time it must happen to keep the deadline.
9. **Report in outcomes, not activity.** Every update says what is merged, green or deployed, what's waiting on whom, and what changed since the last update. Five lines max unless something broke. No running commentary.

## First reply, before doing any work

Keep it to one screen.

1. **You, now.** The 1–3 things only the user can do, each with a "by HH:MM" and a ready-to-paste message or command. This goes first.
2. **Slots.** A table of 30-minute slots until the deadline. Each row says what is DONE at the end of the slot (merged / green / deployed, never "in progress"), and whether it's real work or waiting on whom.
3. **Plan A vs plan B**, and what B drops.
4. **Hidden queues.** The top 5 by time lost, with how to shorten each.
5. **Decided / need you.** The calls you made, one line each, then the at most 3 the user must make.

Then start immediately on rung 1. Don't wait for approval of the plan unless a decision blocks rung 1. In a flow repo, high-risk code still waits for its spec approval (checkpoint 1): put that ask in "You, now".
