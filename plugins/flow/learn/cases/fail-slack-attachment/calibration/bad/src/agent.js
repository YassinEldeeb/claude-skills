// The team assistant in Slack. The model reads SYSTEM_PROMPT, calls tools by name, and reads whatever runTool
// returns, word for word, before it answers in the thread.
import { readThread } from "./slack.js";
import { downloadSlackFile } from "./slackFiles.js";

export const SYSTEM_PROMPT = `You are the team's assistant in Slack. Answer in the thread you were mentioned in.`;

export const TOOLS = {
  read_thread: {
    description: "Read the messages of the current thread. Input: { channel, ts }.",
    run: async ({ channel, ts }) => JSON.stringify(await readThread(channel, ts)),
  },
  read_attachment: {
    description: "Read a file attached in Slack. Input: { file }.",
    run: async ({ file }) => {
      try { return (await downloadSlackFile(file)).toString("base64"); }
      catch (error) { return `Couldn't access the file. Ask the user to re-upload it with accessible permissions. (${error.message})`; }
    },
  },
};

/** What the model reads after calling a tool. */
export async function runTool(name, input) {
  const tool = TOOLS[name];
  if (!tool) return `Unknown tool: ${name}`;
  return tool.run(input ?? {});
}
