# Changelog

- **flow 2.4.2** (2026-10-20): a thread started with `/flow:start` stays a flow task: its goal is repeated on later prompts and after a restart or compaction, a bare `/flow:start` asks for the goal instead of exploring, and an interrupted tool call no longer ends the turn.
- **flow 2.4.1** (2026-10-20): the first rule auto-learn proposed: once you ask for proof ("prove it", "don't say done until…"), a done/fixed report is refused unless it carries its evidence ("42 passed, 0 failed", "CI green").
- **flow 2.4.0** (2026-10-20): failure paths are part of done: each boundary's failures get a decided, tested behavior, agent tools tell the model exactly what failed, and nothing claims a retry or ETA the code doesn't have.
