# WX-1 progress

## Round 1: one city through the real client, before/after (2026-10-19, rev abc1234)
- goal: a second lookup for the same city doesn't reach the provider
- artifact: `test/forecast.test.js` (the run's output is in its first test)
- result: 1 provider call for 2 lookups of Oslo (was 2); expiry at 10 minutes unverified
- next: expiry and failures
- verdict: on-track
