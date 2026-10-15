// UserPromptSubmit: Tim's usage tips, automated.
// - Idle > 60 min with a big context: the prompt cache expired, so the next message re-pays the whole context.
//   Block once and suggest /compact; sending the same message again within 10 min goes through.
// - Context > 500k tokens: warn (requests past that cost more).
// Fails open: any error lets the prompt through.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDLE_MS = 60 * 60_000;
const BIG = 150_000;
const HUGE = 500_000;

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { transcript_path: path, session_id: session } = JSON.parse(input);
  if (!path || !existsSync(path)) process.exit(0);

  // Last assistant turn: its time and the context it sent (input + cache read + cache write).
  let lastAt = 0, context = 0;
  // Only the tail matters (the last assistant turn); transcripts can be tens of MB.
  const size = statSync(path).size, take = Math.min(size, 4 * 1024 * 1024);
  const buf = Buffer.alloc(take), fd = openSync(path, "r");
  readSync(fd, buf, 0, take, size - take); closeSync(fd);
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const record = JSON.parse(line);
      const usage = record?.message?.usage;
      if (record.type !== "assistant" || !usage) continue;
      lastAt = Date.parse(record.timestamp) || lastAt;
      context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    } catch { /* skip a bad line */ }
  }
  if (!lastAt) process.exit(0);

  const k = Math.round(context / 1000);
  const idle = Date.now() - lastAt;
  const marker = join(tmpdir(), `flow-idle-${session}`);
  if (idle > IDLE_MS && context > BIG) {
    const seen = existsSync(marker) && Date.now() - Number(readFileSync(marker, "utf8")) < 10 * 60_000;
    if (!seen) {
      writeFileSync(marker, String(Date.now()));
      process.stderr.write(`[flow] Idle ${Math.round(idle / 60_000)} min with ${k}k tokens of context: the cache expired, so this message re-pays all ${k}k. Run /compact first (or start fresh with a summary). Send the same message again to go ahead anyway.\n`);
      process.exit(2);
    }
  }
  if (context > HUGE) {
    process.stdout.write(JSON.stringify({ systemMessage: `[flow] Context is ${k}k tokens. Past 500k every request costs more and the model gets worse: /compact or start a fresh session with the state in files.` }));
  }
  process.exit(0);
} catch {
  process.exit(0);
}
