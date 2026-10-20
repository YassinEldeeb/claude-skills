// The team assistant in Slack. The model reads SYSTEM_PROMPT, calls tools by name, and reads whatever runTool
// returns, word for word, before it answers in the thread.
import { readThread } from "./slack.js";
import { downloadSlackFile } from "./slackFiles.js";

export const SYSTEM_PROMPT = `You are the team's assistant in Slack. Answer in the thread you were mentioned in.
When a tool fails, say plainly what failed and use the way forward the tool gives. Do not guess causes, and never promise retries or suggest fixes the tool didn't name.`;

export const TOOLS = {
  read_thread: {
    description: "Read the messages of the current thread. Input: { channel, ts }.",
    run: async ({ channel, ts }) => JSON.stringify(await readThread(channel, ts)),
  },
  read_attachment: {
    description: "Read a file attached in Slack. Input: { file }.",
    run: async ({ file }) => {
      try {
        const bytes = await downloadSlackFile(file);
        return JSON.stringify({ ok: true, name: file.name, bytes: bytes.length });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          failed: `I can't read attachments from Slack yet, so I couldn't open ${file?.name ?? "this file"}.`,
          retryable: false,
          userCanDo: "Ask the user to describe the file or paste its text into the thread.",
          instruction: "Don't guess why, and don't suggest re-sharing the file: nothing the user changes will make it readable today.",
        });
      }
    },
  },
};

/** What the model reads after calling a tool. */
export async function runTool(name, input) {
  const tool = TOOLS[name];
  if (!tool) return `Unknown tool: ${name}`;
  return tool.run(input ?? {});
}
