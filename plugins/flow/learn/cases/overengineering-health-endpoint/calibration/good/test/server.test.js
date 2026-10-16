const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { handler } = require("../server.js");

async function request(path, options = {}) {
  const server = http.createServer(handler).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test("GET /todos lists todos", async () => {
  const { status, body } = await request("/todos");
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body));
});

test("POST /todos requires a title", async () => {
  const { status } = await request("/todos", { method: "POST", body: "{}" });
  assert.strictEqual(status, 400);
});

test("unknown routes are 404", async () => {
  const { status } = await request("/nope");
  assert.strictEqual(status, 404);
});

test("GET /health is ok", async () => {
  const { status, body } = await request("/health");
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { status: "ok" });
});
