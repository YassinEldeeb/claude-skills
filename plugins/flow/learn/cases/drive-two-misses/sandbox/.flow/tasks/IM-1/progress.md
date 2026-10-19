# IM-1 progress

## Round 1: dedupe cache (2026-10-17)
- shows: `node -e` import of data/contacts.csv, db usage printed
- scorecard: 300 s database time (target 60 s) · bad row reported: yes
- forecast: no change from the cache; the time is one insert per row
- verdict: off-track

## Round 2: trimmed parse (2026-10-18)
- shows: same run
- scorecard: 300 s database time (target 60 s) · bad row reported: yes
- forecast: unchanged
- verdict: off-track
