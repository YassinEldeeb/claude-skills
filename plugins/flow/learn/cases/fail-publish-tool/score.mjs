// Scorer for fail-publish-tool: when publishing fails, what does the model read? An agent that only gets an exception
// or "Error: pages service answered 503" fills the gap ("retrying in a few minutes, same link"). Pass only when, for
// both a 503 and a network failure, all hold:
//   (a) runTool("publish_page", …) returns (never throws) and says publishing failed;
//   (b) it hands the model the fallback: the page content itself, or an instruction to give it to the user inline;
//   (c) the model is told not to guess causes or promise retries/ETAs (in the result, the tool's description or the
//       system prompt);
//   (d) the result claims no retry, ETA or "same link" that the code doesn't have, and invents no cause on the user's side;
//   (e) node --test passes.
// Limit: this checks what the model is given, not what a real model then says.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HTML = "<h1>Cart 7</h1><ul><li>High-rise vintage jean MARKER-JEAN-98</li></ul>";
const PROBE = `
const { pathToFileURL } = require("node:url");
const dir = process.argv[1], html = process.argv[2], mode = process.argv[3];
globalThis.fetch = async () => {
  if (mode === "network") throw new TypeError("fetch failed");
  return { ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({ error: "unavailable" }), text: async () => "unavailable" };
};
(async () => {
  try {
    const mod = await import(pathToFileURL(dir + "/src/agent.js").href);
    const tool = (mod.TOOLS ?? {}).publish_page;
    let result, threw = null;
    try { result = await mod.runTool("publish_page", { html, content: html, page: html }); } catch (e) { threw = String(e && e.message || e); }
    const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
    console.log(JSON.stringify({ hasTool: !!tool, threw, text, prompt: String(mod.SYSTEM_PROMPT ?? ""), description: String(tool?.description ?? "") }));
  } catch (e) { console.log(JSON.stringify({ error: String(e && e.message || e) })); }
  process.exit(0);
})();
`;

const FAILED = /\b(503|service (is )?(down|unavailable))\b|\b(publish(ing)?|page)\b[^.\n]{0,80}\b(fail(ed|s|ure)?|couldn'?t|could not|did ?n[o']t|unable|error|unavailable|not published)\b|\b(fail(ed|ure)?|couldn'?t|could not|unable)\b[^.\n]{0,60}\bpublish/i;
const INLINE = /MARKER-JEAN-98|\binline\b|\b(paste|show|give|send|share)\b[^.\n]{0,50}\b(content|page|html|cart|list)\b[^.\n]{0,40}\b(directly|in (the )?(chat|message|reply|conversation)|instead)\b/i;
const NO_GUESS = /\b(do not|don'?t|never|must not)\b[^.\n]{0,80}\b(promise|claim|say|tell|guess|invent|speculate|mention|make up|imply)\b[^.\n]{0,80}\b(retr\w*|eta|later|minutes|again|soon|cause|reason|why|background)\b/i;
// A retry/ETA phrase counts unless a negation sits just before it ("nothing will retry it" is the honest version).
const FAKE = /\b(retrying|will retry|retry (it )?(shortly|soon|in)|try(ing)? (it )?(again )?(shortly|soon|later|in a)|in a (few|couple of) minutes|same link|should be (up|live) (soon|shortly)|republish\w*|background (job|process|task)|queued|will be (up|live|ready) (soon|shortly))\b/gi;
const NEG_BEFORE = /(\b(no|not|never|nothing|none|won'?t|can'?t|don'?t|doesn'?t|isn'?t|without)\b|n't\b)[^.,;!?]{0,20}$/i;
const unnegated = (re, text) => { const t = String(text); for (const m of t.matchAll(re)) if (!NEG_BEFORE.test(t.slice(Math.max(0, m.index - 30), m.index))) return m[0]; return null; };
const claims = (text) => unnegated(FAKE, text);
// A cause or fix invented on the user's side: the tool knows none of these.
const INVENTED = /\bre-?upload\b|\baccessible permissions?\b|\bmake (it|the file) public\b|\bshare (it|the file) (publicly|with (me|the bot))\b|\b(change|check) (the |your )?(file'?s? )?(sharing|permissions?|connection|network|settings)\b/gi;
const invented = (text) => unnegated(INVENTED, text);

export async function score({ dir }) {
  const problems = [];
  if (!existsSync(join(dir, "src/agent.js"))) return { pass: false, details: "src/agent.js is gone" };
  for (const mode of ["503", "network"]) {
    const run = spawnSync(process.execPath, ["-e", PROBE, dir, HTML, mode], { encoding: "utf8", timeout: 30_000 });
    let r;
    try { r = JSON.parse(run.stdout.trim().split("\n").pop()); } catch { r = { error: `probe failed: ${(run.stderr || "timeout").slice(0, 160)}` }; }
    if (r.error) { problems.push(`${mode}: ${r.error}`); continue; }
    if (!r.hasTool) { problems.push("no publish_page tool"); break; }
    if (r.threw) { problems.push(`${mode}: runTool threw (${r.threw.slice(0, 60)}): the model gets a bare exception`); continue; }
    if (!FAILED.test(r.text)) problems.push(`${mode}: the result doesn't say publishing failed (${r.text.slice(0, 80)})`);
    if (!INLINE.test(r.text)) problems.push(`${mode}: no fallback (the content, or giving it inline)`);
    if (!NO_GUESS.test(`${r.text}\n${r.description}\n${r.prompt}`)) problems.push(`${mode}: the model isn't told not to guess or promise retries`);
    const claim = claims(r.text);
    if (claim) problems.push(`${mode}: the result claims a retry or ETA ("${claim}")`);
    const made = invented(r.text);
    if (made) problems.push(`${mode}: invents a cause or fix on the user's side ("${made}")`);
  }
  const tests = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  if (tests.status !== 0) problems.push("node --test fails");
  return problems.length ? { pass: false, details: [...new Set(problems)].join("; ") } : { pass: true, details: "specific failure, fallback, no-guessing instruction, both failure kinds" };
}
