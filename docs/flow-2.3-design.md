# flow 2.3: auto-learn

## What it does

flow 2.1 captured corrections and could turn a cluster into a proven fix, but only when someone ran `/flow:learn`. Nobody did. 2.3 runs that loop in the background after a correction, once the engineer has typed `flow auto-learn on`.

`learn/auto.mjs` is started detached by the prompt hook (when it captures a correction) and by session end. One run at a time (`auto.lock`):

1. **Wait** until the triggering session's transcript has been quiet for `idleMinutes` (default 10, or at once when the session ended). Give up after `maxIdleWaitHours`; the next trigger retries.
2. **Classify** that session's typed prompts the lexicon didn't capture, with Haiku (`classifierModel`), into the queue. The lexicon catches about 1 correction in 5 (2.1's measurement); this catches the implicit ones ("what have you been doing for 2 hours?!"). Only valid categories for prompts that exist become incidents.
3. **Pick** one cluster that has new incidents since its last settled attempt (a PR, or not proven), outside its cooldown (`cooldownHours`, 24), within the daily cap (`maxAttemptsPerDay`, 3). An attempt that failed for another reason (a crash, a refused edit) is retried after an hour. Personal and unclassified clusters are never picked.
4. **Analyze** (a fresh headless agent): reads the cluster and up to 3 of its transcripts and returns a synthetic failure description and a root cause. An answer that looks like it holds a secret is dropped.
5. **Cases** (a second fresh agent): gets only the synthetic description and the case format, and writes `learn/cases/auto-<cluster>-<id>/`. It never sees the fix or the threads, which keeps the proof independent.
6. **Fix** (a third agent): the smallest change in skills, `templates/rules.md` or `hooks/constraint-rules.json`.
7. **Prove**: `flow-learn prove` against the repo's default branch. It's the same effectiveness gate as 2.1, with behavioral runs now 4 at a time (`FLOW_EVAL_CONCURRENCY`).
8. **Propose**: `flow-learn propose`, only for `improved` or `enforced`. It opens one draft PR per cluster, rate-limited, synthetic text only, and re-checks the evidence itself.

Every attempt is a line in `auto.jsonl`. The next attended session start shows the new ones in one line.

## Where it runs

- **The clone:** `~/.cache/flow-learn/skills` (`autoLearn.cloneDir`), a private clone of the skills repo (`autoLearn.repo`, default `YassinEldeeb/claude-skills`). It's reset to the default branch before each attempt. It sits outside `~/.claude` because Claude Code refuses headless edits under `.claude` directories; the first real run hit exactly that.
- **The agents:** headless `claude -p` with `--setting-sources local --strict-mcp-config`, so none of the engineer's settings, MCP servers or plugins load. `FLOW_FEEDBACK=off` and `FLOW_AUTO_CHILD=1`, so nothing they do is captured or starts another run. Writes are scoped to the clone's allowed directories. Bash only for the case writer (to calibrate), sandboxed with no network.
- **Pushing and the PR:** the push and `gh pr create` use the engineer's own git and gh credentials. The gh wrapper allows only create, edit, view, list, labels and GET calls.

## What keeps it safe

Two independent reviews blocked the first versions. The rules now:

- **No Bash for any agent,** writes scoped to exact paths, and a check before anything runs that nothing else changed (ignored files included). Claude Code's `.claude/` state is removed after each agent, so nothing carries over.
- **A fix may change only** an existing skill's body (no frontmatter, no `` !`command` `` lines, no new skill), `templates/rules.md`, or the constraint rules (data).
- **Agent-written scorers run under `sandbox-exec`** (macOS): no network but localhost TCP, no writes outside temp dirs, no reads of `~/.claude`, `~/.ssh`, keychains or gh's config. Without that sandbox, behavioral cases are refused. Eval runs can't leave their Bash sandbox.
- **Privacy, before any proof:** the analysis, the change, every added line and every new path are checked against the engineer's sessions (whole transcripts: prompts, replies, tool output). The check looks for 5-word runs and identifiers from them, home paths, real emails, URLs, secrets, and repo, user and git names. Runs, identifiers and names already public in the skills repo don't count. A hit ends the attempt: `refused-private`, no PR.
- **The base is pinned by sha** after the fetch, and git runs with fsmonitor and hooks off.

## Cost

It runs on the engineer's Claude plan; a Max plan has no extra charge. It uses plan quota: an attempt is three agent runs plus the proof (one run per prompt per arm, across the target case and the behavioral suite). That's why it waits for idle time and is capped per day.

## The switch

Off by default. `flow auto-learn on` / `off`, typed in a prompt (pasted text never counts), or `flow-learn auto on` / `off` in a terminal. The Bash guard refuses `flow-learn auto on/off` from an agent.

## Tested

`test/auto.test.mjs`, zero spend, with a fake `claude` and a fake `gh` against a local bare repo:
- A "don't push" cluster goes through analysis, an independent case, a constraint-rule fix and the proof (`enforced`), and ends as a draft PR. The PR branch holds only the rule and the case, and the engineer's words never reach the PR or the commit.
- A sloppy fix (a rule that blocks every git command) is rejected, and no PR opens.
- A second run with nothing new does nothing.

There are also tests for the switch (typed only, never pasted, never by an agent), picking, the detached start, the classifier and the session-start notice.

## First real run

On 2026-10-19 the loop ran on real corrections: 6 "said done without verifying" incidents across 5 sessions. It opened [#4](https://github.com/YassinEldeeb/claude-skills/pull/4), a draft with a `verify-before-report` constraint rule and an independent deterministic case (24 fixtures, `enforced`). That run used the code before the second review's hardening. Its text and diff pass the hardened privacy check against those 5 transcripts. The first attempt before it failed: the clone sat under `~/.claude`, where Claude Code refuses headless edits, so the clone moved to `~/.cache`.

## Limits

- The proof runs on small synthetic cases. A proven fix is evidence, not a guarantee.
- Every attempt spends quota, even when nothing proves. Most attempts are expected to end "not proven" until the cases get sharper.
- The idle check looks at the triggering session only, not at the engineer's other sessions.
