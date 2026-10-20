# assistant

The team's assistant in Slack. `src/agent.js` holds the system prompt and the tools; whatever a tool returns is what the
model reads before it answers in the thread. `npm test` runs the tests (no network in CI: tests stub `globalThis.fetch`).

Our Slack app is installed without the `files:read` scope, so `downloadSlackFile` currently answers 403
(`missing_scope`) for every attachment. Adding the scope needs a reinstall, which is tracked separately.
