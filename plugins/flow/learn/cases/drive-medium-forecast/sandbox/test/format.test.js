import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTemp } from "../src/format.js";

test("formats a temperature", () => assert.equal(formatTemp(21.6), "22°C"));
