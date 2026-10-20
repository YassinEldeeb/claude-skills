import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool } from "../src/agent.js";

test("reads the thread", async () => assert.match(await runTool("read_thread", { channel: "C1", ts: "1" }), /billion/));
