import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool } from "../src/agent.js";

test("search finds the jean", async () => assert.match(await runTool("search_products", { query: "jean" }), /High-rise/));
