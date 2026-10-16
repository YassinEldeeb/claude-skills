// UserPromptSubmit: a token warning that never blocks.
// - Idle past the prompt-cache TTL with a big context: the next message re-reads the whole context.
// - Context over 500k tokens: requests cost more and get worse.
// The TTL depends on the provider and plan: FLOW_CACHE_TTL_MIN (default 60). Fails open.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const TTL_MIN = Number(process.env.FLOW_CACHE_TTL_MIN) || 60;
const BIG = 150_000;
const HUGE = 500_000;

try {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const { transcript_path: path } = JSON.parse(text);
  if (!path || !existsSync(path)) process.exit(0);

  // Only the tail matters (the last assistant turn); transcripts can be tens of MB.
  const size = statSync(path).size, take = Math.min(size, 4 * 1024 * 1024);
  const buf = Buffer.alloc(take), fd = openSync(path, "r");
  readSync(fd, buf, 0, take, size - take);
  closeSync(fd);
  let lastAt = 0, context = 0;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const record = JSON.parse(line);
      const usage = record?.message?.usage;
      if (record.type !== "assistant" || !usage || record.isSidechain) continue;
      lastAt = Date.parse(record.timestamp) || lastAt;
      context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    } catch { /* skip a bad line */ }
  }
  if (!lastAt) process.exit(0);

  const k = Math.round(context / 1000);
  const idleMin = Math.round((Date.now() - lastAt) / 60_000);
  const notes = [];
  if (idleMin > TTL_MIN && context > BIG) notes.push(`idle ${idleMin} min with ${k}k tokens of context: the prompt cache (TTL ${TTL_MIN} min) has likely expired, so this message re-reads all ${k}k. Before a long pause, write the state to the task and /compact.`);
  if (context > HUGE) notes.push(`context is ${k}k tokens: past 500k every request costs more and quality drops. Write the state to files and /compact or start fresh.`);
  if (notes.length) process.stdout.write(JSON.stringify({ systemMessage: `[flow] ${notes.join(" ")}` }));
  process.exit(0);
} catch {
  process.exit(0);
}
