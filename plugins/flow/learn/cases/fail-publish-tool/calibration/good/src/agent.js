// The shopping assistant. The model reads SYSTEM_PROMPT, calls tools by name, and reads whatever runTool returns,
// word for word, before it answers the user.
import { searchProducts } from "./catalog.js";
import { publishPage } from "./publish.js";

export const SYSTEM_PROMPT = `You are a shopping assistant. Help the user find products, build their cart and share it.
When a tool fails, tell the user what failed and give them the fallback the tool returns. Do not guess causes, and never promise retries, ETAs or background work the system doesn't do.`;

export const TOOLS = {
  search_products: {
    description: "Search the catalog. Input: { query }.",
    run: async ({ query }) => JSON.stringify(await searchProducts(query)),
  },
  publish_page: {
    description: "Publish the cart page. Input: { html }. Returns the link, or a failure with the content to give inline.",
    run: async ({ html }) => {
      try {
        return JSON.stringify({ ok: true, url: await publishPage(html) });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          failed: "Publishing the page failed; there is no link and nothing will retry it.",
          retryable: false,
          userCanDo: "Give the user the page content inline in your reply.",
          content: html,
          instruction: "Do not guess why it failed and do not promise a retry or an ETA.",
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
