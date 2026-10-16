// SessionEnd (async: never delays the engineer). Derives behavioral signals locally from the transcript Claude Code
// already keeps, stores counts only (never text), then starts the deterministic worker in the background.
// A session may have no transcript (or an unreadable one): then the session is recorded with signals "unavailable".
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { transcriptSignals } from "../learn/classify.mjs";
import { appendLog, captureAllowed, enqueue, loadSession, safe } from "../learn/store.mjs";
import { PLUGIN_VERSION, repoFlowConfig, repoOf } from "./capture.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const MAX_BYTES = 64 * 1024 * 1024;

async function readTranscript(path) {
  if (!path || !existsSync(path) || statSync(path).size > MAX_BYTES) return null;
  const records = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"') && !line.includes('"text"')) continue;
    try { records.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return records;
}

try {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  if (process.env.FLOW_FEEDBACK === "off" || process.env.CLAUDE_CODE_SESSION_ATTENDED === "0") process.exit(0);
  const { root, name } = repoOf(input.cwd || process.cwd());
  if (!captureAllowed(repoFlowConfig(root))) process.exit(0);
  const records = await readTranscript(input.transcript_path).catch(() => null);
  const session = loadSession(input.session_id);
  const event = {
    type: "session", at: new Date().toISOString(), session: input.session_id, repo: name, reason: input.reason ?? null,
    signals: records ? transcriptSignals(records) : null,
    prompts: session.prompts ?? 0, corrections: session.corrections ?? [],
    model: session.model ?? null, version: PLUGIN_VERSION,
  };
  enqueue(event);
  safe(() => appendLog("sessions.jsonl", { at: event.at, session: event.session, repo: name, prompts: event.prompts, corrections: event.corrections.length, signals: event.signals }));
  // The worker is deterministic and local (no model calls); it never runs evals.
  const child = spawn(process.execPath, [join(here, "../learn/cli.mjs"), "process", "--quiet"], { detached: true, stdio: "ignore", env: { ...process.env, FLOW_FEEDBACK: "off" } });
  child.unref();
  process.exit(0);
} catch {
  process.exit(0);
}
