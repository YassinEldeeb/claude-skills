// The hooks and the offline CLI commands, run as real processes against a throwaway git repo.
import "./isolate.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CONFIG, task, taskFiles } from "./fixtures.mjs";

const plugin = new URL("..", import.meta.url).pathname;
// Every hook run gets its own feedback store: tests must never write to the engineer's real ~/.claude/flow-feedback.
const testStore = mkdtempSync(join(tmpdir(), "flow-hooks-store-"));
const hook = (name, input) => spawnSync("node", [join(plugin, "hooks", name)], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, FLOW_FEEDBACK_HOME: testStore } });
let repo;
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
const write = (path, text) => { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), text); };

before(() => {
  repo = mkdtempSync(join(tmpdir(), "flow-hooks-"));
  git("init", "-q", "-b", "main");
  write(".flow/config.json", JSON.stringify(CONFIG));
  mkdirSync(join(repo, ".github/flow"), { recursive: true });
  cpSync(join(plugin, "gate/lib.mjs"), join(repo, ".github/flow/lib.mjs"));
  cpSync(join(plugin, "gate/flow.mjs"), join(repo, ".github/flow/flow.mjs"));
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("checkout", "-q", "-b", "feature/memory");
});
after(() => rmSync(repo, { recursive: true, force: true }));

describe("edit guard", () => {
  test("no task: an ordinary edit passes, a high-risk edit is routed through /flow:start", () => {
    assert.equal(hook("guard-edit.mjs", { cwd: repo, tool_input: { file_path: join(repo, "src/ui.ts"), content: "export const a = 1;" } }).status, 0);
    const migration = hook("guard-edit.mjs", { cwd: repo, tool_input: { file_path: join(repo, "db/migrations/1.sql"), content: "ALTER TABLE a ADD b int;" } });
    assert.equal(migration.status, 2);
    assert.match(migration.stderr, /high risk \(migration/);
    const worker = hook("guard-edit.mjs", { cwd: repo, tool_input: { file_path: join(repo, "src/jobs.ts"), new_string: "await queue.add('x', job)" } });
    assert.equal(worker.status, 2, "line rules see the new content");
  });

  test("a high task on this branch holds code edits until its approved spec is synced", () => {
    const t = task("high", { branch: "feature/memory", pr: 7 });
    for (const [path, text] of Object.entries(taskFiles(t))) write(path, text);
    const code = { cwd: repo, tool_input: { file_path: join(repo, "src/worker.ts"), content: "x" } };
    const held = hook("guard-edit.mjs", code);
    assert.equal(held.status, 2);
    assert.match(held.stderr, /spec is not approved yet/);
    assert.match(held.stderr, /\/flow approve T-1 spec@[0-9a-f]{24}/);
    assert.equal(hook("guard-edit.mjs", { cwd: repo, tool_input: { file_path: join(repo, ".flow/tasks/T-1/design.md"), content: "x" } }).status, 0, "spec files stay editable");
    assert.equal(hook("guard-edit.mjs", { cwd: repo, tool_input: { file_path: join(repo, "docs/notes.md"), content: "x" } }).status, 0, "docs stay editable");

    const hash = /spec@([0-9a-f]{24})/.exec(held.stderr)[1];
    write(".flow/tasks/T-1/.approved", `spec@${hash} by alice on PR #7\n`);
    assert.equal(hook("guard-edit.mjs", code).status, 0, "synced approval releases the hold");
    write(".flow/tasks/T-1/design.md", "A different design now.");
    assert.equal(hook("guard-edit.mjs", code).status, 2, "changing the approved design holds edits again");
  });

  test("MultiEdit and NotebookEdit inputs are checked too, and the gate config is risky", () => {
    rmSync(join(repo, ".flow/tasks/T-1/.approved"), { force: true });
    rmSync(join(repo, ".flow/tasks/T-1"), { recursive: true, force: true });
    const multi = hook("guard-edit.mjs", { cwd: repo, tool_input: { file_path: join(repo, "src/jobs.ts"), edits: [{ old_string: "a", new_string: "cron.schedule('* * * * *', sweep)" }] } });
    assert.equal(multi.status, 2);
    const notebook = hook("guard-edit.mjs", { cwd: repo, tool_input: { notebook_path: join(repo, "nb/backfill.ipynb"), new_source: "await queue.add('x')" } });
    assert.equal(notebook.status, CONFIG.codeFiles.some((g) => g.endsWith(".ipynb")) ? 2 : 0, "notebooks are scanned only when codeFiles includes them");
    const config = hook("guard-edit.mjs", { cwd: repo, tool_input: { file_path: join(repo, ".flow/config.json"), content: "{}" } });
    assert.equal(config.status, 2);
    assert.match(config.stderr, /flow-gate/);
    for (const [path, text] of Object.entries(taskFiles(task("high", { branch: "feature/memory", pr: 7 })))) write(path, text);
  });

  test("an agent can't write the approval record itself", () => {
    const r = hook("guard-edit.mjs", { cwd: repo, tool_input: { file_path: join(repo, ".flow/tasks/T-1/.approved"), content: "spec@x by alice" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Never write them yourself/);
  });
});

describe("self-authorization guard", () => {
  for (const command of [
    "gh pr comment 7 --body '/flow approve T-1 spec@0123456789abcdef01234567'",
    "node .github/flow/flow.mjs approve '/flow approve T-1 ship@0123456789abcdef01234567' --post --pr 7",
    "echo 'flow approve x' | ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n flow",
    "echo 'spec@abc by alice' > .flow/tasks/T-1/.approved",
    "GH_TOKEN=x gh pr merge 7 --squash --admin",
    "gh api -X PUT repos/acme/app/branches/main/protection --input p.json",
    "gh api --method DELETE repos/acme/app/rulesets/42",
    "ssh-keygen -Ysign -f k -n flow < m",
    "gh api --method=PUT repos/acme/app/branches/main/protection --input p.json",
    "gh api repos/acme/app/rulesets --input r.json",
    "gh pr merge 7 --squash \\\n  --admin",
    "cp /tmp/x .flow/tasks/T-1/.approved",
  ]) {
    test(`refuses: ${command.slice(0, 60)}`, () => assert.equal(hook("guard-bash.mjs", { cwd: repo, tool_input: { command } }).status, 2));
  }
  for (const command of ["gh pr merge 7 --squash", "node .github/flow/flow.mjs sync T-1", "gh api -X GET repos/acme/app/branches/main/protection", "gh api repos/acme/app/rules/branches/main", "git status", 'git commit -m "docs: how /flow approve works"', "cat .flow/tasks/T-1/.approved"]) {
    test(`allows: ${command}`, () => assert.equal(hook("guard-bash.mjs", { cwd: repo, tool_input: { command } }).status, 0));
  }
  test("does nothing outside a flow repo", () => {
    const plain = mkdtempSync(join(tmpdir(), "flow-plain-"));
    execFileSync("git", ["init", "-q"], { cwd: plain });
    assert.equal(hook("guard-bash.mjs", { cwd: plain, tool_input: { command: "gh pr merge 1 --admin" } }).status, 0);
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("session start and the context guard", () => {
  test("session start names the branch's task and what holds it", () => {
    const r = hook("session-start.mjs", { cwd: repo });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Task T-1 \(high\)/);
    assert.match(r.stdout, /\/flow:start/);
  });

  test("a big context no longer asks for /compact on every prompt; a session that predates the window hears it once", () => {
    const transcript = join(repo, "t.jsonl");
    const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const usage = (tokens) => `${JSON.stringify({ type: "assistant", timestamp: old, message: { usage: { input_tokens: 10, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 } } })}\n`;
    const prompt = (session, env = {}) => spawnSync("node", [join(plugin, "hooks", "prompt.mjs")], { input: JSON.stringify({ transcript_path: transcript, session_id: session }), encoding: "utf8", env: { ...process.env, FLOW_FEEDBACK_HOME: testStore, CLAUDE_CODE_SESSION_ATTENDED: "1", ...env } });
    const settings = join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    try {
      // No window set (the engineer's own choice, or flow hasn't run session start yet): quiet, idle or not.
      writeFileSync(transcript, usage(600_000));
      const quiet = prompt("ctx-1");
      assert.equal(quiet.status, 0);
      assert.equal(quiet.stdout, "");
      // A 500k window is set but this session is past it: it started before the setting. One line, once.
      writeFileSync(settings, JSON.stringify({ autoCompactWindow: 500_000 }));
      assert.match(JSON.parse(prompt("ctx-2").stdout).systemMessage, /at 600k tokens, over the 500k auto-compact window/);
      assert.equal(prompt("ctx-2").stdout, "");
      // Headless sessions, a larger window the engineer chose, a small context, or a compaction since: nothing.
      assert.equal(prompt("ctx-5", { CLAUDE_CODE_SESSION_ATTENDED: "0" }).stdout, "");
      writeFileSync(settings, JSON.stringify({ autoCompactWindow: 900_000 }));
      assert.equal(prompt("ctx-3").stdout, "");
      writeFileSync(settings, JSON.stringify({ autoCompactWindow: 500_000 }));
      writeFileSync(transcript, usage(600_000) + `${JSON.stringify({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" })}\n`);
      assert.equal(prompt("ctx-6").stdout, "");
      writeFileSync(transcript, usage(20_000));
      assert.equal(prompt("ctx-4").stdout, "");
    } finally { rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true }); }
  });
});

describe("autoCompactWindow (flow 2.4.4)", () => {
  // Each case: a fresh Claude config dir and a fresh flow store, an attended session start.
  const start = (setup = () => {}, env = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "flow-acw-claude-")), store = mkdtempSync(join(tmpdir(), "flow-acw-store-"));
    writeFileSync(join(store, "config.json"), JSON.stringify({ noticeShown: "x" }));
    setup(dir, store);
    const run = (more = {}) => spawnSync("node", [join(plugin, "hooks", "session-start.mjs")], { input: JSON.stringify({ session_id: "s", cwd: repo, source: "startup" }), encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: dir, FLOW_FEEDBACK_HOME: store, CLAUDE_CODE_SESSION_ATTENDED: "1", ...env, ...more } });
    const settings = () => { try { return readFileSync(join(dir, "settings.json"), "utf8"); } catch { return null; } };
    return { dir, store, run, settings, done: () => { rmSync(dir, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }); } };
  };
  const SET = /compacts a session by itself as it nears 500k tokens/;

  test("sets 500k once, keeps the rest of the file byte for byte, and tells the engineer", () => {
    const original = '{\n    "model": "opus",\n    "permissions": { "allow": ["Bash(ls)"] }\n}\n';
    const c = start((dir) => writeFileSync(join(dir, "settings.json"), original, { mode: 0o640 }));
    try {
      const r = c.run();
      assert.equal(r.status, 0);
      assert.match(JSON.parse(r.stdout).systemMessage, SET);
      assert.equal(c.settings(), '{\n    "model": "opus",\n    "permissions": { "allow": ["Bash(ls)"] },\n    "autoCompactWindow": 500000\n}\n');
      assert.equal(statSync(join(c.dir, "settings.json")).mode & 0o777, 0o640);
      // Removed by the engineer: never set again, and no message.
      writeFileSync(join(c.dir, "settings.json"), '{ "model": "opus" }\n');
      const again = c.run();
      assert.doesNotMatch(again.stdout, SET);
      assert.equal(c.settings(), '{ "model": "opus" }\n');
    } finally { c.done(); }
  });

  test("keeps CRLF line endings and a one-line file's shape; creates the file when there is none", () => {
    const crlf = start((dir) => writeFileSync(join(dir, "settings.json"), '{\r\n  "model": "opus"\r\n}\r\n'));
    const empty = start((dir) => writeFileSync(join(dir, "settings.json"), "{}"));
    const none = start();
    try {
      crlf.run(); empty.run(); none.run();
      assert.equal(crlf.settings(), '{\r\n  "model": "opus",\r\n  "autoCompactWindow": 500000\r\n}\r\n');
      assert.deepEqual(JSON.parse(empty.settings()), { autoCompactWindow: 500_000 });
      assert.deepEqual(JSON.parse(none.settings()), { autoCompactWindow: 500_000 });
    } finally { crlf.done(); empty.done(); none.done(); }
  });

  test("writes through a symlinked settings file and keeps the link", () => {
    const c = start((dir) => {
      mkdirSync(join(dir, "dotfiles"));
      writeFileSync(join(dir, "dotfiles", "claude.json"), '{"model": "opus"}');
      symlinkSync(join(dir, "dotfiles", "claude.json"), join(dir, "settings.json"));
    });
    try {
      c.run();
      assert.ok(lstatSync(join(c.dir, "settings.json")).isSymbolicLink());
      assert.deepEqual(JSON.parse(readFileSync(join(c.dir, "dotfiles", "claude.json"), "utf8")), { model: "opus", autoCompactWindow: 500_000 });
    } finally { c.done(); }
  });

  test("a window the engineer already had stays theirs, even after they remove it", () => {
    const c = start((dir) => writeFileSync(join(dir, "settings.json"), '{"autoCompactWindow": 800000}'));
    try {
      c.run();
      assert.equal(c.settings(), '{"autoCompactWindow": 800000}');
      writeFileSync(join(c.dir, "settings.json"), "{}");
      c.run();
      assert.equal(c.settings(), "{}");
    } finally { c.done(); }
  });

  for (const [name, setup, env] of [
    ["a per-model window", (dir) => writeFileSync(join(dir, "settings.json"), '{"modelOverrides": {"opus": {"autoCompactWindow": "auto"}}}')],
    ["auto-compact turned off in settings", (dir) => writeFileSync(join(dir, "settings.json"), '{"autoCompactEnabled": false}')],
    ["auto-compact turned off in /config", (dir) => { writeFileSync(join(dir, "settings.json"), "{}"); writeFileSync(join(dir, ".claude.json"), '{"autoCompactEnabled": false}'); }],
    ["the window set in the environment", (dir) => writeFileSync(join(dir, "settings.json"), "{}"), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "700000" }],
    ["compaction disabled in the environment", (dir) => writeFileSync(join(dir, "settings.json"), "{}"), { DISABLE_AUTO_COMPACT: "1" }],
    ["a settings file that isn't valid JSON", (dir) => writeFileSync(join(dir, "settings.json"), '{"model": "opus",}')],
    ["a read-only settings file", (dir) => writeFileSync(join(dir, "settings.json"), "{}", { mode: 0o444 })],
    ["a symlink to nowhere", (dir) => symlinkSync(join(dir, "missing.json"), join(dir, "settings.json"))],
    ["a headless session", (dir) => writeFileSync(join(dir, "settings.json"), "{}"), { CLAUDE_CODE_SESSION_ATTENDED: "0" }],
    ["a session that doesn't say it's attended", (dir) => writeFileSync(join(dir, "settings.json"), "{}"), { CLAUDE_CODE_SESSION_ATTENDED: "" }],
  ]) {
    test(`leaves the settings alone: ${name}`, () => {
      const c = start(setup, env);
      try {
        const before = c.settings(), linked = (() => { try { return lstatSync(join(c.dir, "settings.json")).isSymbolicLink(); } catch { return false; } })();
        const r = c.run();
        assert.equal(r.status, 0);
        assert.equal(c.settings(), before);
        if (linked) assert.ok(lstatSync(join(c.dir, "settings.json")).isSymbolicLink());
        assert.doesNotMatch(r.stdout, SET);
      } finally { c.done(); }
    });
  }

  test("feedback capture off doesn't turn this off", () => {
    const c = start((dir) => writeFileSync(join(dir, "settings.json"), "{}"), { FLOW_FEEDBACK: "off" });
    try {
      c.run();
      assert.deepEqual(JSON.parse(c.settings()), { autoCompactWindow: 500_000 });
    } finally { c.done(); }
  });
});

describe("offline CLI", () => {
  const cli = (...args) => spawnSync("node", [join(repo, ".github/flow/flow.mjs"), ...args], { cwd: repo, encoding: "utf8" });
  test("validate reports a broken task, token prints the approval line", () => {
    write(".flow/tasks/T-2/task.json", JSON.stringify({ schema: 1, id: "T-2", title: "x", tier: "medium", signals: ["nope"] }));
    const v = cli("validate");
    assert.equal(v.status, 1);
    assert.match(v.stdout, /unknown risk rule "nope"/);
    rmSync(join(repo, ".flow/tasks/T-2"), { recursive: true });
    assert.match(cli("token", "T-1").stdout, /^\/flow approve T-1 spec@[0-9a-f]{24}\n$/);
  });
  test("classify reads the local diff, including new untracked files", () => {
    git("remote", "add", "origin", repo);
    git("fetch", "-q", "origin", "main");
    write("db/migrations/9.sql", "ALTER TABLE a ADD b int;");
    const r = cli("classify", "--base", "main");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /high\s+migration/);
  });
  test("the CLI refuses a local config with --post", () => {
    const r = cli("check", "--pr", "1", "--repo", "acme/app", "--post", "--config", ".flow/config.json");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /local dry runs/);
  });
});

describe("a /flow:start thread stays a flow task", () => {
  test("the goal is repeated on later prompts, in both forms the command can arrive in, until 'stop flow'", () => {
    const home = mkdtempSync(join(tmpdir(), "flow-thread-"));
    try {
      const env = { FLOW_FEEDBACK_HOME: home };
      const say = (session, prompt) => spawnSync("node", [join(plugin, "hooks/prompt.mjs")], { input: JSON.stringify({ session_id: session, cwd: home, prompt, source: "user" }), encoding: "utf8", env: { ...process.env, ...env } }).stdout;
      const said = (session, prompt) => { const out = say(session, prompt); try { return JSON.parse(out).hookSpecificOutput?.additionalContext ?? ""; } catch { return out; } };
      assert.doesNotMatch(said("t1", "/flow:start fix the login redirect loop"), /flow:start task/, "not on the command itself");
      assert.match(said("t1", "continue!"), /This thread is a \/flow:start task: "fix the login redirect loop"/);
      assert.match(said("t1", "ok, stop flow"), /ended flow for this thread/);
      said("t1", "/flow:start fix the login redirect loop");
      said("t2", "<command-message>flow:start</command-message>\n<command-name>/flow:start</command-name>\n<command-args>add a health endpoint</command-args>");
      assert.match(said("t2", "keep going"), /"add a health endpoint"/);
      assert.doesNotMatch(said("t3", "continue"), /flow:start task/, "other threads are untouched");
      assert.match(said("t1", "stop flow"), /ended flow for this thread/);
      assert.doesNotMatch(said("t1", "continue"), /flow:start task/);
      said("t4", "/flow:start");
      assert.match(said("t4", "continue"), /started \/flow:start without a goal/);
      assert.doesNotMatch(said("t5", "end flow control is broken in the parser"), /ended flow/, "only the stop phrase alone, and only with a goal");
      assert.doesNotMatch(said("t6", "here is a transcript: <command-name>/flow:start</command-name><command-args>x</command-args> what happened?"), /x/, "the command form only at the start");
      assert.doesNotMatch(said("t6", "continue"), /flow:start task/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  test("a resumed or compacted session hears the goal from session start", () => {
    const home = mkdtempSync(join(tmpdir(), "flow-thread-ss-"));
    try {
      const env = { ...process.env, FLOW_FEEDBACK_HOME: home, CLAUDE_CODE_SESSION_ATTENDED: "1" };
      writeFileSync(join(home, "config.json"), JSON.stringify({ noticeShown: "x" }));
      spawnSync("node", [join(plugin, "hooks/prompt.mjs")], { input: JSON.stringify({ session_id: "r1", cwd: home, prompt: "/flow:start ship the export button", source: "user" }), encoding: "utf8", env });
      const resumed = spawnSync("node", [join(plugin, "hooks/session-start.mjs")], { input: JSON.stringify({ session_id: "r1", cwd: home, source: "resume" }), encoding: "utf8", env }).stdout;
      assert.match(resumed, /This thread is a \/flow:start task: "ship the export button"/);
      const fresh = spawnSync("node", [join(plugin, "hooks/session-start.mjs")], { input: JSON.stringify({ session_id: "r1", cwd: home, source: "startup" }), encoding: "utf8", env }).stdout;
      assert.doesNotMatch(fresh, /flow:start task/, "only on resume or compact");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
