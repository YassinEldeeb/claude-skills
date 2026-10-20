# assistant

A chat shopping assistant. `src/agent.js` holds the system prompt and the tools; whatever a tool returns is what the
model reads before it answers. `npm test` runs the tests (no network in CI: tests stub `globalThis.fetch`).
