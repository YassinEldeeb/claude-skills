// The hooks and the offline CLI commands, run as real processes against a throwaway git repo.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CONFIG, task, taskFiles } from "./fixtures.mjs";

const plugin = new URL("..", import.meta.url).pathname;
const hook = (name, input) => spawnSync("node", [join(plugin, "hooks", name)], { input: JSON.stringify(input), encoding: "utf8" });
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

  test("the context guard warns but never blocks", () => {
    const transcript = join(repo, "t.jsonl");
    const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", timestamp: old, message: { usage: { input_tokens: 10, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 0 } } })}\n`);
    const r = hook("context-guard.mjs", { transcript_path: transcript, session_id: "s" });
    assert.equal(r.status, 0);
    const message = JSON.parse(r.stdout).systemMessage;
    assert.match(message, /idle 180 min with 600k/);
    assert.match(message, /past 500k/);
    const fresh = new Date().toISOString();
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", timestamp: fresh, message: { usage: { input_tokens: 10, cache_read_input_tokens: 20_000 } } })}\n`);
    assert.equal(hook("context-guard.mjs", { transcript_path: transcript }).stdout, "");
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
