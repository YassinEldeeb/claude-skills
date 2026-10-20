// Downloads a file someone attached in Slack, with the bot token.
export async function downloadSlackFile(file, token = process.env.SLACK_BOT_TOKEN) {
  const res = await fetch(file.url_private, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`slack file download answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
