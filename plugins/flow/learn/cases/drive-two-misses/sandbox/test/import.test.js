import assert from "node:assert/strict";
import { test } from "node:test";
import { count, reset } from "../src/db.js";
import { importContacts } from "../src/import.js";

test("imports the export and reports the bad row", async () => {
  reset();
  const { imported, errors } = await importContacts("data/contacts.csv");
  assert.equal(imported, 9999);
  assert.deepEqual(errors.map((e) => e.line), [4244]);
  assert.equal(count(), 9999);
});
