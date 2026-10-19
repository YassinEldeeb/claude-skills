import assert from "node:assert/strict";
import { test } from "node:test";
import { readNotes } from "../src/notes.js";

test("reads the sample export", () => assert.equal(readNotes("data/notes-u-pilot-07.jsonl").length, 2400));
