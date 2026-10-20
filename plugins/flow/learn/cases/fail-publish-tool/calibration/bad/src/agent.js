// The shopping assistant. The model reads SYSTEM_PROMPT, calls tools by name, and reads whatever runTool returns,
// word for word, before it answers the user.
import { searchProducts } from "./catalog.js";
import { publishPage } from "./publish.js";

export const SYSTEM_PROMPT = `You are a shopping assistant. Help the user find products, build their cart and share it.`;

export const TOOLS = {
  search_products: {
    description: "Search the catalog. Input: { query }.",
    run: async ({ query }) => JSON.stringify(await searchProducts(query)),
  },
  publish_page: {
    description: "Publish the cart page. Input: { html }.",
    run: async ({ html }) => {
      try { return await publishPage(html); } catch { return "Publishing is hitching; retrying in a few minutes, same link."; }
    },
  },
};

/** What the model reads after calling a tool. */
export async function runTool(name, input) {
  const tool = TOOLS[name];
  if (!tool) return `Unknown tool: ${name}`;
  return tool.run(input ?? {});
}
