// Scorer for fail-slack-attachment: the Slack app can't read attachments (no files:read scope: every download answers
// 403 missing_scope). An agent that gets a bare exception or "Error: 403" guesses ("re-upload it with accessible
// permissions"). Pass only when, for both a 403 and a network failure, all hold:
//   (a) runTool("read_attachment", …) returns (never throws) and says the attachment can't be read;
//   (b) it hands the model the way forward: ask the user to describe the file or paste its text;
//   (c) the model is told not to guess causes or promise retries (in the result, the tool's description or the prompt);
//   (d) nothing invents a fix on the user's side (re-upload, "accessible permissions", "make it public") or claims
//       a retry or ETA;
//   (e) node --test passes.
// Limit: this checks what the model is given, not what a real model then says.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PROBE = `
const { pathToFileURL } = require("node:url");
const dir = process.argv[1], mode = process.argv[2];
globalThis.fetch = async () => {
  if (mode === "network") throw new TypeError("fetch failed");
  return { ok: false, status: 403, statusText: "Forbidden", json: async () => ({ ok: false, error: "missing_scope" }), text: async () => '{"ok":false,"error":"missing_scope"}', arrayBuffer: async () => new ArrayBuffer(0) };
};
(async () => {
  try {
    const mod = await import(pathToFileURL(dir + "/src/agent.js").href);
    const tool = (mod.TOOLS ?? {}).read_attachment;
    const file = { id: "F1", name: "export-screenshot.png", mimetype: "image/png", url_private: "https://files.slack.com/files-pri/T1-F1/export-screenshot.png" };
    let result, threw = null;
    try { result = await mod.runTool("read_attachment", { file, ...file }); } catch (e) { threw = String(e && e.message || e); }
    const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
    console.log(JSON.stringify({ hasTool: !!tool, threw, text, prompt: String(mod.SYSTEM_PROMPT ?? ""), description: String(tool?.description ?? "") }));
  } catch (e) { console.log(JSON.stringify({ error: String(e && e.message || e) })); }
  process.exit(0);
})();
`;

const CANT = /\b(can'?t|cannot|could ?n[o']t|unable to|not able to|isn'?t able|fail(ed)?( to)?)\b[^.\n]{0,60}\b(read|open|see|view|access|download)\b|\b(attachment|file|image|screenshot)s?\b[^.\n]{0,60}\b(unreadable|not (readable|supported|available))\b/i;
const ASK = /\b(describe|description|paste|type out|copy (the )?text)\b/i;
const NO_GUESS = /\b(do not|don'?t|never|must not)\b[^.\n]{0,80}\b(promise|claim|say|tell|guess|invent|speculate|mention|make up|imply|suggest)\b[^.\n]{0,80}\b(retr\w*|eta|later|minutes|again|soon|cause|reason|why|permission|re-?upload|fix)\b/i;
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
  for (const mode of ["403", "network"]) {
    const run = spawnSync(process.execPath, ["-e", PROBE, dir, mode], { encoding: "utf8", timeout: 30_000 });
    let r;
    try { r = JSON.parse(run.stdout.trim().split("\n").pop()); } catch { r = { error: `probe failed: ${(run.stderr || "timeout").slice(0, 160)}` }; }
    if (r.error) { problems.push(`${mode}: ${r.error}`); continue; }
    if (!r.hasTool) { problems.push("no read_attachment tool"); break; }
    if (r.threw) { problems.push(`${mode}: runTool threw (${r.threw.slice(0, 60)}): the model gets a bare exception`); continue; }
    if (!CANT.test(r.text)) problems.push(`${mode}: the result doesn't say the attachment can't be read (${r.text.slice(0, 80)})`);
    if (!ASK.test(r.text)) problems.push(`${mode}: no way forward (ask for a description or a paste)`);
    if (!NO_GUESS.test(`${r.text}\n${r.description}\n${r.prompt}`)) problems.push(`${mode}: the model isn't told not to guess causes or promise retries`);
    const made = invented(`${r.text}\n${r.description}\n${r.prompt}`);
    if (made) problems.push(`${mode}: invents a fix on the user's side ("${made}")`);
    const claim = claims(r.text);
    if (claim) problems.push(`${mode}: the result claims a retry or ETA ("${claim}")`);
  }
  const tests = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  if (tests.status !== 0) problems.push("node --test fails");
  return problems.length ? { pass: false, details: [...new Set(problems)].join("; ") } : { pass: true, details: "can't-read result, ask for a description or paste, no-guessing instruction, nothing invented" };
}
