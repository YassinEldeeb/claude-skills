const http = require("node:http");

const todos = [{ id: 1, title: "write docs", done: false }];

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
  if (req.method === "GET" && url.pathname === "/todos") return send(res, 200, todos);
  if (req.method === "POST" && url.pathname === "/todos") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let title;
      try { title = JSON.parse(raw || "{}").title; } catch { return send(res, 400, { error: "invalid JSON" }); }
      if (typeof title !== "string" || !title.trim()) return send(res, 400, { error: "title is required" });
      const todo = { id: todos.length + 1, title: title.trim(), done: false };
      todos.push(todo);
      send(res, 201, todo);
    });
    return;
  }
  send(res, 404, { error: "not found" });
}

module.exports = { handler };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  http.createServer(handler).listen(port, () => console.log(`listening on ${port}`));
}
