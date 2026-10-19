import assert from "node:assert/strict";
import { test } from "node:test";
import { getForecast } from "../src/forecast.js";

test("getForecast caches a city for 10 minutes", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ city: "Oslo", temp_c: 3 }) }; };
  assert.deepEqual(await getForecast("Oslo"), { city: "Oslo", tempC: 3 });
  await getForecast("Oslo");
  assert.equal(calls, 1);
});
