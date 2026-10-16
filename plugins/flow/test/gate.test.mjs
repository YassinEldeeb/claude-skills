import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { approveLine, checkToPost, commentState, diffHash, headPrsFrom, evaluate, globToRegExp, parseUnifiedDiff, prNumbersFromEvent, render, signedMessage, sshVerifier } from "../gate/lib.mjs";
import { CONFIG, comment, ctx, green, hashOf, task, taskFiles } from "./fixtures.mjs";

const has = (result, text) => result.blockers.some((b) => b.includes(text));
const passing = (t, extra = {}) => { const head = taskFiles(t, extra.head); return { head, body: `Flow-Task: ${t.id}`, checks: green("db-tests"), ...extra, head }; };

describe("fail closed", () => {
  test("no config on the protected branch is an error, not a pass", async () => {
    const r = await evaluate({ ...ctx(), config: undefined, configError: ".flow/config.json does not exist on main" });
    assert.equal(r.ok, false);
    assert.match(r.error, /does not exist/);
  });
  test("a config with nobody to approve is an error", async () => {
    const r = await evaluate(ctx({ config: { ...CONFIG, approvers: [], signers: [] } }));
    assert.equal(r.ok, false);
    assert.match(r.error, /nobody could approve/);
  });
  test("an unknown config schema is an error", async () => {
    const r = await evaluate(ctx({ config: { ...CONFIG, schema: 2 } }));
    assert.match(r.error, /schema must be 1/);
  });
  test("a named task that is missing or malformed blocks", async () => {
    assert.ok(has(await evaluate(ctx({ body: "Flow-Task: T-9" })), "does not exist"));
    const r = await evaluate(ctx({ body: "Flow-Task: T-1", head: { ".flow/tasks/T-1/task.json": "{ nope" } }));
    assert.ok(has(r, "not valid JSON"));
  });
  test("a task with an unknown field (like a typed approver name) blocks", async () => {
    const t = task("medium", { approvedBy: "claude" });
    assert.ok(has(await evaluate(ctx(passing(t))), 'unknown field "approvedBy"'));
  });
  test("a truncated file list is an error", async () => {
    assert.match((await evaluate({ ...ctx(), filesTruncated: true })).error, /split it/);
  });
});

describe("small fast path", () => {
  test("no risk and an Evidence section passes with no task", async () => {
    const r = await evaluate(ctx({ head: { "src/ui/button.tsx": "export const label = 'Save';" }, body: "## What changed\nlabel\n\n## Evidence\nran the button test" }));
    assert.equal(r.ok, true, r.blockers.join("\n"));
    assert.equal(r.small, true);
  });
  test("an empty Evidence section blocks", async () => {
    const r = await evaluate(ctx({ head: { "src/ui/button.tsx": "x" }, body: "## Evidence\n<!-- what you ran -->\n" }));
    assert.ok(has(r, "Evidence"));
  });
  test("a bot-authored PR is judged like any other", async () => {
    const r = await evaluate(ctx({ author: "dependabot[bot]", head: { "db/migrations/001.sql": "ALTER TABLE x ADD y int;" } }));
    assert.ok(has(r, "detected high risk"));
  });
});

describe("tier comes from the diff", () => {
  test("a migration with no task is high and blocks", async () => {
    const r = await evaluate(ctx({ head: { "db/migrations/002.sql": "ALTER TABLE users ADD plan text;" }, body: "## Evidence\nran it" }));
    assert.equal(r.tier, "high");
    assert.ok(has(r, "detected high risk"));
  });
  test("editing the gate or its config is high risk", async () => {
    const r = await evaluate(ctx({ head: { ".flow/config.json": "{}" }, body: "## Evidence\nx" }));
    assert.ok(r.signals.some((s) => s.id === "flow-gate"));
  });
  test("any CI workflow change is a gate change (any workflow can post a check)", async () => {
    const r = await evaluate(ctx({ head: { ".github/workflows/ci.yml": "on: pull_request" }, body: "## Evidence\nx" }));
    assert.ok(r.signals.some((s) => s.id === "flow-gate"));
    assert.equal(r.tier, "high");
  });
  test("removing lines counts: deleting a cron is a worker change", async () => {
    const files = [{ filename: "src/jobs.ts", status: "modified", patch: "-cron.schedule('* * * * *', sweep)", additions: 0 }];
    assert.ok((await evaluate(ctx({ files, body: "## Evidence\nx" }))).signals.some((s) => s.id === "worker"));
  });
  test("a file the API can't show a patch for is high, never small", async () => {
    const files = [{ filename: "src/huge.ts", status: "modified", additions: 9000 }];
    const r = await evaluate(ctx({ files, body: "## Evidence\nx" }));
    assert.equal(r.tier, "high");
    assert.ok(r.signals.some((s) => s.id === "unscanned"));
  });
  test("a rename out of a risky path still counts", async () => {
    const files = [{ filename: "src/legacy/old.ts", previous_filename: "src/auth/session.ts", status: "renamed", patch: "", additions: 0 }];
    assert.ok((await evaluate(ctx({ files, body: "## Evidence\nx" }))).signals.some((s) => s.id === "auth"));
  });
  test("a new top-level directory is at least medium", async () => {
    const r = await evaluate(ctx({ head: { "worker/index.ts": "export {}" }, body: "## Evidence\nx" }));
    assert.ok(r.signals.some((s) => s.id === "new-module"));
  });
  test("a detected signal no task lists blocks (adding it changes the spec)", async () => {
    const t = task("medium");
    const p = passing(t, { head: { "db/migrations/003.sql": "ALTER TABLE a ADD b int;" } });
    assert.ok(has(await evaluate(ctx(p)), 'detected risk "migration"'));
  });
  test("a task can't declare itself below its signals without an override approval", async () => {
    const t = task("small", { signals: ["auth"] });
    const p = passing(t);
    const r = await evaluate(ctx(p));
    assert.equal(r.tasks[0].tier, "high");
    assert.ok(has(r, "lowers the tier from high to small"));
    const hash = hashOf(t, p.head);
    const approved = await evaluate(ctx({ ...p, comments: [comment("alice", approveLine("T-1", "override", hash))] }));
    assert.equal(approved.ok, true, approved.blockers.join("\n"));
    assert.equal(approved.tasks[0].tier, "small");
  });
  test("a task that was high on the protected branch can't quietly drop to medium", async () => {
    const t = task("medium");
    const p = passing(t);
    const r = await evaluate(ctx({ ...p, base: { ".flow/tasks/T-1/task.json": JSON.stringify(task("high")) } }));
    assert.ok(has(r, "lowers the tier from high to medium"));
  });
  test("deleting or renaming a task record blocks", async () => {
    const del = [{ filename: ".flow/tasks/T-1/task.json", status: "removed", additions: 0 }];
    assert.ok(has(await evaluate(ctx({ files: del, body: "## Evidence\nx" })), "removes task T-1"));
    const ren = [{ filename: ".flow/tasks/T-2/task.json", previous_filename: ".flow/tasks/T-1/task.json", status: "renamed", patch: "", additions: 0 }];
    assert.ok(has(await evaluate(ctx({ files: ren })), "renames task T-1"));
  });
  test("a PR into an unprotected branch is not judged (stacked work is judged when it targets main)", async () => {
    const r = await evaluate(ctx({ prBase: "yassin/base", head: { "db/migrations/1.sql": "x" } }));
    assert.equal(r.ok, true);
    assert.match(r.skipped, /not a protected branch/);
  });
});

describe("medium needs evidence, not a human", () => {
  test("a complete medium task passes with no approval", async () => {
    const r = await evaluate(ctx(passing(task("medium"))));
    assert.equal(r.ok, true, r.blockers.join("\n"));
    assert.equal(r.paste.length, 0);
  });
  test("a light challenge is required: simplest option and two failure modes", async () => {
    const r = await evaluate(ctx(passing(task("medium", { challenge: { simplest: "n/a", failureModes: ["one way"] } }))));
    assert.ok(has(r, "challenge.simplest"));
    assert.ok(has(r, "failureModes"));
  });
  test("independent verification is required", async () => {
    const t = task("medium");
    const p = passing(t);
    delete p.head[".flow/tasks/T-1/verify.md"];
    assert.ok(has(await evaluate(ctx(p)), "no independent verification"));
    p.head[".flow/tasks/T-1/verify.md"] = "found two bugs\nverdict: blocked";
    assert.ok(has(await evaluate(ctx(p)), "verdict: pass"));
  });
  test("with review bots configured, their approving review of this commit is the verification", async () => {
    const config = { ...CONFIG, reviewBots: ["review-bot"] };
    const p = passing(task("medium"));
    assert.ok(has(await evaluate(ctx({ ...p, config })), "no approving review from review-bot"));
    const reviews = [{ user: { login: "review-bot" }, state: "APPROVED", commit_id: "a".repeat(40) }];
    assert.equal((await evaluate(ctx({ ...p, config, reviews }))).ok, true);
    const stale = [{ user: { login: "review-bot" }, state: "APPROVED", commit_id: "b".repeat(40) }];
    assert.ok(has(await evaluate(ctx({ ...p, config, reviews: stale })), "no approving review"));
  });
  test("an open 🔴 decision blocks", async () => {
    const r = await evaluate(ctx(passing(task("medium", { decisions: [{ id: "D1", question: "Keep the old API for a release?" }] }))));
    assert.ok(has(r, "decision D1 is open"));
  });
  test("a waiver needs an override approval", async () => {
    const t = task("medium", { signals: ["model-call"], waivers: [{ item: "capacity", why: "internal tool, ten users" }] });
    const p = passing(t);
    const r = await evaluate(ctx(p));
    assert.ok(has(r, "waives capacity"));
    assert.ok(has(r, "capacity is required"), "an unapproved waiver waives nothing");
    const ok = await evaluate(ctx({ ...p, comments: [comment("alice", approveLine("T-1", "override", hashOf(t, p.head)))] }));
    assert.equal(ok.ok, true, ok.blockers.join("\n"));
  });
});

describe("approvals are identity-checked and bound to content", () => {
  const t = task("high");
  const p = passing(t);
  const hash = hashOf(t, p.head);
  const both = (files) => [comment("alice", approveLine("T-1", "spec", hash)), comment("alice", approveLine("T-1", "ship", diffHash(files)))];
  const files = ctx(p).files;

  test("a high task asks for spec then ship approval, and passes with both from an approver", async () => {
    const r = await evaluate(ctx(p));
    assert.ok(has(r, "spec is not approved"));
    assert.deepEqual(r.paste, [approveLine("T-1", "spec", hash)]);
    const ok = await evaluate(ctx({ ...p, comments: both(files) }));
    assert.equal(ok.ok, true, ok.blockers.join("\n"));
    assert.equal(ok.stages.authorized, "pass");
  });
  for (const [who, opts, why] of [
    ["agent-bot", {}, "agent login"],
    ["mallory", {}, "not in config.approvers"],
    ["alice", { type: "Bot" }, "bot"],
    ["alice", { edited: true }, "edited"],
  ]) {
    test(`an approval ${why} doesn't count`, async () => {
      const r = await evaluate(ctx({ ...p, comments: [comment(who, approveLine("T-1", "spec", hash), opts)] }));
      assert.ok(has(r, "spec is not approved"));
      assert.ok(r.unknowns.some((u) => u.includes("ignored spec approval")));
    });
  }
  test("an agent login never approves, even if it is also listed as an approver", async () => {
    const config = { ...CONFIG, approvers: ["alice", "agent-bot"] };
    const r = await evaluate(ctx({ ...p, config, author: "someone", comments: [comment("agent-bot", approveLine("T-1", "spec", hash))] }));
    assert.ok(has(r, "spec is not approved"));
    assert.ok(r.unknowns.some((u) => u.includes("agent login")));
  });
  test("the PR author can't approve their own PR (distinctApprover)", async () => {
    const r = await evaluate(ctx({ ...p, author: "alice", comments: [comment("alice", approveLine("T-1", "spec", hash))] }));
    assert.ok(has(r, "spec is not approved"));
  });
  test("only the first line counts: quotes and prose never approve", async () => {
    const quoted = comment("alice", `> ${approveLine("T-1", "spec", hash)}`);
    const prose = comment("alice", `Not yet. Once fixed I'll post:\n${approveLine("T-1", "spec", hash)}`);
    assert.ok(has(await evaluate(ctx({ ...p, comments: [quoted, prose] })), "spec is not approved"));
  });
  test("changing the spec after approval voids it", async () => {
    const changed = { ...t, outcome: "A new user gets a useful memory within an hour, whenever" };
    const head = taskFiles(changed);
    const r = await evaluate(ctx({ ...p, head, comments: both(files) }));
    assert.ok(has(r, "spec is not approved"));
    assert.ok(r.unknowns.some((u) => u.includes("covers an earlier version")));
  });
  test("changing the design doc after approval voids it", async () => {
    const head = { ...p.head, ".flow/tasks/T-1/design.md": "Full history first after all." };
    assert.ok(has(await evaluate(ctx({ ...p, head, comments: both(files) })), "spec is not approved"));
  });
  test("progress fields (evidence, log) don't void the spec approval", async () => {
    const progressed = { ...t, log: ["🟡 renamed a helper"] };
    const head = taskFiles(progressed);
    const r = await evaluate(ctx({ ...p, head, comments: [comment("alice", approveLine("T-1", "spec", hash))] }));
    assert.ok(!has(r, "spec is not approved"));
  });
  test("ship approval covers these exact changes: any new change voids it", async () => {
    const head = { ...p.head, "src/extra.ts": "export const x = 1;" };
    const r = await evaluate(ctx({ ...p, head, comments: both(files) }));
    assert.ok(has(r, "authorizes these exact changes"));
  });
  test("labels and Markdown names carry no weight", async () => {
    const r = await evaluate(ctx({ ...p, body: `Flow-Task: T-1\nApproved by: alice\nhuman-approved` }));
    assert.ok(has(r, "spec is not approved"));
  });
});

describe("signed approvals (real ssh-keygen)", () => {
  const hasSsh = (() => { try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); return true; } catch (e) { return e.status !== undefined; } })();
  test("only a signature by a configured signer counts, whoever posts it", { skip: !hasSsh && "no ssh-keygen" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-ssh-"));
    try {
      const keygen = (name) => { execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", join(dir, name)]); return readFileSync(join(dir, `${name}.pub`), "utf8").trim(); };
      const sign = (name, message) => execFileSync("ssh-keygen", ["-Y", "sign", "-f", join(dir, name), "-n", "flow"], { input: message, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
      const human = keygen("human"); keygen("agent");
      const config = { ...CONFIG, approvers: [], signers: [{ name: "yassin", key: human }] };
      const t = task("medium", { signals: ["auth"], tier: "medium" });
      const p = passing(t);
      const hash = hashOf(t, p.head);
      const line = approveLine("T-1", "override", hash);
      const real = { ...ctx({ ...p, config }), verifySignature: sshVerifier(config.signers) };
      const post = (who, signer) => comment(who, `${line}\n\n${sign(signer, signedMessage("acme/app", "T-1", "override", hash))}`);

      const ok = await evaluate({ ...real, comments: [post("agent-bot", "human")] });
      assert.equal(ok.ok, true, ok.blockers.join("\n"));
      const forged = await evaluate({ ...real, comments: [post("alice", "agent")] });
      assert.ok(has(forged, "lowers the tier"));
      const unsigned = await evaluate({ ...real, comments: [comment("alice", line)] });
      assert.ok(unsigned.unknowns.some((u) => u.includes("not signed")));
      const otherRepo = await evaluate({ ...real, repo: "acme/other", comments: [post("alice", "human")] });
      assert.ok(has(otherRepo, "lowers the tier"), "a signature can't be replayed in another repo");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("evidence is checked, not claimed", () => {
  const medium = (evidence, extraHead = {}, checks = green("db-tests")) => {
    const t = task("medium", { evidence });
    return ctx({ ...passing(t, { head: extraHead }), checks });
  };
  test("a missing test file, a missing test name, a skipped test", async () => {
    assert.ok(has(await evaluate(medium({ "T-1.1": ["test:src/nope.int.test.ts#reads a recent memory"] })), "does not exist"));
    assert.ok(has(await evaluate(medium({ "T-1.1": ["test:src/bootstrap.int.test.ts#some other test"] })), "declares no test named"));
    const skipped = { "src/bootstrap.int.test.ts": 'test.skip("reads a recent memory", () => {});' };
    assert.ok(has(await evaluate(medium({ "T-1.1": ["test:src/bootstrap.int.test.ts#reads a recent memory"] }, skipped)), "skipped"));
    const commented = { "src/bootstrap.int.test.ts": '// test("reads a recent memory") later' };
    assert.ok(has(await evaluate(medium({ "T-1.1": ["test:src/bootstrap.int.test.ts#reads a recent memory"] }, commented)), "skipped, a todo or a comment"));
  });
  test("a test outside the kind's paths doesn't count (no unit test dressed as integration)", async () => {
    const extra = { "src/bootstrap.test.ts": 'test("reads a recent memory", () => {})' };
    assert.ok(has(await evaluate(medium({ "T-1.1": ["test:src/bootstrap.test.ts#reads a recent memory"] }, extra)), "is not where integration tests live"));
  });
  test("the kind's suite must have passed on this commit", async () => {
    const r = await evaluate(medium({ "T-1.1": ["test:src/bootstrap.int.test.ts#reads a recent memory"] }, {}, [{ name: "db-tests", conclusion: "failure" }]));
    assert.ok(has(r, "has not passed on this commit"));
  });
  test("a ci: ref must be a passing check of the right kind", async () => {
    assert.ok(has(await evaluate(medium({ "T-1.1": ["ci:lint"] }, {}, green("lint", "db-tests"))), 'is not a integration check'));
    assert.equal((await evaluate(medium({ "T-1.1": ["ci:db-tests"] }))).ok, true);
  });
  test("a url only counts for manual criteria", async () => {
    assert.ok(has(await evaluate(medium({ "T-1.1": ["url:https://example.com/screenshot.png"] })), "only counts for manual"));
  });
  test("a normal criterion without evidence is an unknown, not a blocker", async () => {
    const t = task("medium", { criteria: [...task("medium").criteria, { id: "T-1.9", kind: "functional", severity: "normal", verify: "unit", behavior: "The settings page shows the bootstrap date" }] });
    const r = await evaluate(ctx(passing(t)));
    assert.equal(r.ok, true, r.blockers.join("\n"));
    assert.ok(r.unknowns.some((u) => u.includes("T-1.9 unproven")));
  });
});

describe("pieces", () => {
  test("globs", () => {
    assert.ok(globToRegExp("**/migrations/**").test("db/migrations/1.sql"));
    assert.ok(globToRegExp("**/migrations/**").test("migrations/1.sql"));
    assert.ok(globToRegExp("**/*auth.*").test("src/oauth.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  });
  test("parseUnifiedDiff keeps added and removed lines, renames and binaries", () => {
    const files = parseUnifiedDiff("diff --git a/x.ts b/y.ts\nrename from x.ts\nrename to y.ts\n--- a/x.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-old\n+new\n--- removed SQL comment\ndiff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\ndiff --git \"a/my file.ts\" \"b/my file.ts\"\n@@ -0,0 +1 @@\n+x\n");
    assert.equal(files[0].previous_filename, "x.ts");
    assert.equal(files[0].patch, "-old\n+new\n--- removed SQL comment\n", "a removed line starting with -- is still a change");
    assert.equal(files[1].patch, undefined);
    assert.equal(files[2].filename, "my file.ts");
  });
  test("render escapes task text: no mentions, links or HTML from a spec", async () => {
    const t = task("medium", { title: "Ping @alice [click](https://evil) <img src=x>" });
    const out = render(await evaluate(ctx(passing(t))), { pr: 7 });
    assert.ok(!out.includes("@alice"));
    assert.ok(!out.includes("[click](https://evil)"));
    assert.ok(!out.includes("<img"));
  });
});

describe("fresh-eyes review fixes", () => {
  test("a skipped PR posts no check run (a commit can be shared with a PR into main)", async () => {
    const r = await evaluate(ctx({ prBase: "yassin/base", head: { "src/a.ts": "x" } }));
    assert.equal(checkToPost(r), null);
    assert.deepEqual(checkToPost({ ok: false, blockers: ["x"], tier: "high" }), { ok: false, title: "flow: 1 blocker" });
  });
  test("evidence and gold-set paths can't climb out of the repo (they'd reach other API endpoints)", async () => {
    const t = task("medium", { evidence: { "T-1.1": ["test:x/integration/../../../issues/1#reads a recent memory"] } });
    assert.ok(has(await evaluate(ctx(passing(t))), "not a plain repository path"));
    const e = task("medium", { criteria: [{ id: "T-1.1", kind: "functional", severity: "critical", verify: "eval", behavior: "Matches the gold set facts" }], evidence: { "T-1.1": ["eval:x"] }, evals: { gold: { good: 6, bad: 6, correct: 12, ref: "../issues/1" }, results: { runs: 3, safetyFailures: 0, unknown: 0 } } });
    assert.ok(has(await evaluate(ctx(passing(e))), "not a plain repository path"));
  });
  test("an old task can't be cited to cover new work", async () => {
    const old = task("medium", { id: "OLD-1", pr: 3 });
    const head = { ...taskFiles(old), "src/prompts/system.txt": "be nicer" };
    const files = [{ filename: "src/prompts/system.txt", status: "modified", patch: "+be nicer", additions: 1 }];
    const r = await evaluate(ctx({ head, files, body: "Flow-Task: OLD-1", checks: green("db-tests") }));
    assert.ok(has(r, "a finished task can't cover new work"));
  });
  test("task text inside blockers can't mention, link or break the table", async () => {
    const t = task("medium", { decisions: [{ id: "D1 @acme/admins", question: "Ping @acme/admins | <b>x</b> [link](https://evil.example)" }] });
    const out = render(await evaluate(ctx(passing(t))));
    assert.ok(!out.includes("@acme"), "no raw mention");
    assert.ok(!out.includes("<b>"));
    assert.ok(!out.includes("](https://"));
    assert.ok(!out.includes("https://evil"), "bare URLs are not autolinked");
  });
  test("the verdict is the last non-empty line", async () => {
    const p = passing(task("medium"));
    p.head[".flow/tasks/T-1/verify.md"] = "Round 1\nverdict: pass\nRound 2 found a bug.\nverdict: blocked\n";
    assert.ok(has(await evaluate(ctx(p)), 'end with "verdict: pass"'));
  });
  test("a test in a skipped block, or only named in an assertion, doesn't count; .only does", async () => {
    const m = (text) => evaluate(ctx(passing(task("medium"), { head: { "src/bootstrap.int.test.ts": text } })));
    assert.ok(has(await m('describe.skip("bootstrap", () => { test("reads a recent memory", () => {}) })'), "skipped"));
    assert.ok(has(await m('describe.skip("bootstrap", () => {\n  test("reads a recent memory", () => {});\n});'), "skipped block"));
    assert.ok(has(await m('test("other", () => { expect(x, "reads a recent memory").toBe(1) })'), "declares no test named"));
    assert.equal((await m('test.only("reads a recent memory", () => {})')).ok, true);
  });
  test("a rename or empty file with no patch is not 'unscanned'", async () => {
    const files = [{ filename: "src/b.ts", previous_filename: "src/a.ts", status: "renamed", changes: 0, additions: 0 }];
    const r = await evaluate(ctx({ files, body: "## Evidence\nrenamed" }));
    assert.equal(r.ok, true, r.blockers.join("\n"));
  });
  test("medium work needs at least one critical criterion", async () => {
    const t = task("medium", { criteria: [{ id: "T-1.1", kind: "functional", severity: "normal", verify: "unit", behavior: "The label reads Save changes" }], evidence: {} });
    assert.ok(has(await evaluate(ctx(passing(t))), "at least one criterion must be critical"));
  });
  test("a kind with no configured CI check can't prove a critical criterion", async () => {
    const config = { ...CONFIG, verify: { ...CONFIG.verify, integration: { paths: ["**/*.int.test.*"], checks: [] } } };
    assert.ok(has(await evaluate(ctx({ ...passing(task("medium")), config })), "names no CI check"));
  });
});

describe("e2e findings (real GitHub sandbox, 2026-10-16)", () => {
  test("approval lines stay copyable: no zero-width space inside spec@<hash>, code spans intact", async () => {
    const t = task("high");
    const out = render(await evaluate(ctx(passing(t))));
    assert.ok(!/spec@\u200b/.test(out) && !/ship@\u200b/.test(out));
    assert.match(out, /an approver posts `\/flow approve T-1 spec@[0-9a-f]{24}`/);
    assert.ok(render(await evaluate(ctx(passing(task("medium", { title: "ping @acme/admins" }))))).includes("@\u200bacme"), "real mentions are still neutralized");
    const tricky = render(await evaluate(ctx(passing(task("medium", { title: "`@org/admins` and ops@example.com" })))));
    assert.ok(!tricky.includes("`@org") && !/[^\u200b]@org/.test(tricky.replace(/\\`/g, "`")), "a backticked mention is neutralized");
    assert.ok(!tricky.includes("ops@example"), "an email doesn't autolink");
  });
  test("a head shared with a PR into another branch gets a note on what to do", async () => {
    const r = await evaluate({ ...ctx(passing(task("medium"))), headPrs: [{ number: 7, base: "main" }, { number: 3, base: "side" }] });
    assert.ok(r.unknowns.some((u) => u.includes("PR #3 (into side)") && u.includes("push a new commit")));
    assert.equal(r.ok, true, "a note, not a blocker");
  });
  test("a head shared with a PR into another protected branch blocks (the verdicts would overwrite each other)", async () => {
    const config = { ...CONFIG, branches: ["main", "release"] };
    const r = await evaluate({ ...ctx({ ...passing(task("medium")), config }), headPrs: [{ number: 5, base: "release" }] });
    assert.ok(has(r, "PR #5 into release, another protected branch"));
  });
  test("only /flow comments by people decide whether a verdict is stale", () => {
    const base = [{ id: 1, user: { type: "User" }, body: "/flow approve T-1 spec@" + "a".repeat(24), updated_at: "t1" }];
    const thanks = [...base, { id: 2, user: { type: "User" }, body: "thanks!", updated_at: "t2" }];
    const dash = [...base, { id: 3, user: { type: "Bot" }, body: "<!-- flow:dashboard --> /flow", updated_at: "t3" }];
    assert.equal(commentState(thanks), commentState(base), "a plain comment triggers no run, so it can't make a verdict stale");
    assert.equal(commentState(dash), commentState(base), "the gate's own dashboard doesn't count");
    assert.notEqual(commentState([{ ...base[0], updated_at: "t9" }]), commentState(base), "an edited approval does");
  });
  test("head PRs: only open PRs whose head is this commit", () => {
    const pulls = [
      { number: 1, state: "open", head: { sha: "h" }, base: { ref: "main" } },
      { number: 2, state: "closed", head: { sha: "h" }, base: { ref: "side" } },
      { number: 3, state: "open", head: { sha: "later" }, base: { ref: "main" } },
    ];
    assert.deepEqual(headPrsFrom(pulls, "h"), [{ number: 1, base: "main" }]);
    assert.deepEqual(headPrsFrom({ message: "error" }, "h"), []);
  });
  test("escaping: &#64; can't smuggle a mention; only an approval hash keeps a bare @", async () => {
    const out = render(await evaluate(ctx(passing(task("medium", { title: "&#64;acme ship@evil.com" })))));
    assert.ok(!out.includes("&#64;acme"), "the entity is escaped");
    assert.ok(!out.includes("ship@evil"), "ship@ followed by a non-hash gets the zero-width space");
  });
  test("a workflow_run judges every PR it lists, not just the first", () => {
    assert.deepEqual(prNumbersFromEvent("workflow_run", { workflow_run: { pull_requests: [{ number: 3 }, { number: 2 }, { number: 3 }] } }), [3, 2]);
    assert.deepEqual(prNumbersFromEvent("issue_comment", { issue: { number: 9, pull_request: {} } }), [9]);
    assert.deepEqual(prNumbersFromEvent("issue_comment", { issue: { number: 9 } }), []);
    assert.deepEqual(prNumbersFromEvent("pull_request_target", { pull_request: { number: 4 } }), [4]);
  });
  test("workflow templates queue gate runs (never cancel) and never run PR code", () => {
    for (const name of ["flow.yml", "flow-hardened.yml"]) {
      const text = readFileSync(new URL(`../templates/github/workflows/${name}`, import.meta.url), "utf8");
      assert.ok(!/cancel-in-progress:\s*true/.test(text), `${name}: cancel-in-progress must be false`);
      assert.match(text, /\n {4}concurrency:/, `${name}: concurrency is job-level`);
      assert.ok(!/github\.event\.pull_request\.head\.(sha|ref)/.test(text), `${name}: never check out the PR head`);
      assert.match(text, /comment\.user\.type != 'Bot'/, `${name}: bot comments don't trigger runs`);
    }
  });
});
