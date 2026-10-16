// The Memory v2 failures, replayed against the gate. Each must block early, then pass once the missing work is done.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { approveLine, diffHash, evaluate, render } from "../gate/lib.mjs";
import { CONFIG, comment, ctx, green, hashOf, task, taskFiles } from "./fixtures.mjs";

const has = (result, text) => result.blockers.some((b) => b.includes(text));
const approved = (t, head, files) => [comment("alice", approveLine(t.id, "spec", hashOf(t, head))), comment("alice", approveLine(t.id, "ship", diffHash(files)))];

describe("S1: backfill architecture built before workload, cost and first-useful latency were known", () => {
  const code = { "src/memory/backfill.ts": "export async function backfillAll(users) {\n  for (const u of users) await queue.add('extract', u);\n}\nconst res = await client.messages.create({ model, messages });" };

  test("code alone is classified high and needs a task before anything else", async () => {
    const r = await evaluate(ctx({ head: code, body: "## Evidence\nunit tests pass" }));
    assert.equal(r.tier, "high");
    assert.deepEqual(r.signals.map((s) => s.id).sort(), ["bulk", "model-call", "worker"]);
    assert.ok(has(r, "detected high risk"));
  });

  test("a task without a capacity model, alternatives or measured workload blocks", async () => {
    const t = task("high", { signals: ["worker", "bulk", "model-call"], capacity: undefined });
    t.challenge = { ...t.challenge, alternatives: [{ name: "full history", why: "the plan we already had", chosen: true }] };
    const head = taskFiles(t, code);
    const r = await evaluate(ctx({ head, body: "Flow-Task: T-1", checks: green("db-tests") }));
    assert.ok(has(r, "capacity is required"));
    assert.ok(has(r, "at least 2 options"));
    const estimates = task("high", { signals: ["worker", "bulk", "model-call"] });
    estimates.capacity.workload.workPerUser = { value: "about 500 sources", source: "estimate", basis: "a guess from one account" };
    const r2 = await evaluate(ctx({ head: taskFiles(estimates, code), body: "Flow-Task: T-1", checks: green("db-tests") }));
    assert.ok(has(r2, "no measured production number"));
  });

  test("an unverified critical assumption blocks merge; marked as a rollout blocker it lets an internal canary merge but not roll out", async () => {
    const cohort = { text: "The customer cohort is about 1,200 new users a week", status: "unverified", blocks: "merge" };
    const t = task("high", { signals: ["worker", "bulk", "model-call"] });
    t.challenge = { ...t.challenge, assumptions: [...t.challenge.assumptions, cohort] };
    let head = taskFiles(t, code);
    let c = ctx({ head, body: "Flow-Task: T-1", checks: green("db-tests") });
    assert.ok(has(await evaluate({ ...c, comments: approved(t, head, c.files) }), "unverified assumption blocks merge"));

    const canary = task("high", { signals: ["worker", "bulk", "model-call"] });
    canary.challenge = { ...canary.challenge, assumptions: [...canary.challenge.assumptions, { ...cohort, blocks: "rollout" }] };
    head = taskFiles(canary, code);
    c = ctx({ head, body: "Flow-Task: T-1", checks: green("db-tests") });
    const r = await evaluate({ ...c, comments: approved(canary, head, c.files) });
    assert.equal(r.ok, true, r.blockers.join("\n"));
    assert.deepEqual(r.rolloutBlockers, ["The customer cohort is about 1,200 new users a week"]);
  });

  test("the approval card shows the capacity numbers with their sources first", async () => {
    const t = task("high", { signals: ["worker", "bulk", "model-call"] });
    const out = render(await evaluate(ctx({ head: taskFiles(t, code), body: "Flow-Task: T-1", checks: green("db-tests") })));
    assert.match(out, /workload\.workPerUser \| ✅ pass \| p95 900 sources · measured 2026-10-14/);
    assert.match(out, /latency\.firstResult \| ❔ estimate/);
  });
});

describe("S2: raw eval failures read as product defects", () => {
  const evalTask = (results, gold = { good: 12, bad: 8, correct: 20, ref: "evals/gold/cases.json" }, severity = "critical") => task("medium", {
    criteria: [{ id: "T-1.1", kind: "functional", severity, verify: "eval", behavior: "Saved memories match the gold set's expected facts" }],
    evidence: { "T-1.1": ["eval:memory-gold"] },
    evals: { gold, results },
  });
  const base = { "evals/gold/cases.json": "[]" };
  const run = (t, extra = {}) => evaluate(ctx({ head: taskFiles(t, extra), base, body: "Flow-Task: T-1", checks: green("db-tests") }));

  test("eval evidence doesn't count without a validated scorer", async () => {
    const r = await run(evalTask({ runs: 3, raw: { pass: 126, fail: 59 }, productDefects: 0, safetyFailures: 0, evalDefects: 59, unknown: 0 }, null));
    assert.ok(has(r, "no gold set"));
    const tiny = await run(evalTask({ runs: 3, raw: { pass: 1, fail: 0 }, safetyFailures: 0, unknown: 0 }, { good: 2, bad: 1, correct: 3, ref: "evals/gold/cases.json" }));
    assert.ok(has(tiny, "at least 10 in all"));
    const wrong = await run(evalTask({ runs: 3, raw: { pass: 1, fail: 0 }, safetyFailures: 0, unknown: 0 }, { good: 12, bad: 8, correct: 18, ref: "evals/gold/cases.json" }));
    assert.ok(has(wrong, "18/20"));
  });

  test("the gold set must already be on the protected branch, unchanged by this PR", async () => {
    const t = evalTask({ runs: 3, raw: { pass: 1, fail: 0 }, safetyFailures: 0, unknown: 0 }, { good: 12, bad: 8, correct: 20, ref: "evals/new-gold.json" });
    assert.ok(has(await run(t), "not on the base branch"));
    const edited = evalTask({ runs: 3, raw: { pass: 1, fail: 0 }, safetyFailures: 0, unknown: 0 });
    assert.ok(has(await run(edited, { "evals/gold/cases.json": "[\"easier\"]" }), "changes the gold set"));
  });

  test("a safety failure blocks; unattributed results block a critical eval; one run is noise", async () => {
    assert.ok(has(await run(evalTask({ runs: 3, raw: { pass: 126, fail: 59 }, productDefects: 4, safetyFailures: 1, evalDefects: 54, unknown: 0 })), "eval safety failure"));
    assert.ok(has(await run(evalTask({ runs: 3, raw: { pass: 126, fail: 59 }, productDefects: 4, safetyFailures: 0, evalDefects: 53, unknown: 2 })), "not yet attributed"));
    assert.ok(has(await run(evalTask({ runs: 1, raw: { pass: 126, fail: 59 }, productDefects: 4, safetyFailures: 0, evalDefects: 55, unknown: 0 })), "at least 3 runs"));
  });

  test("attributed quality failures alone don't block: the dashboard separates product defects from eval defects", async () => {
    const r = await run(evalTask({ runs: 3, raw: { pass: 126, fail: 59 }, productDefects: 6, safetyFailures: 0, evalDefects: 53, unknown: 0 }));
    assert.equal(r.ok, true, r.blockers.join("\n"));
    assert.match(render(r), /product defects 6 · safety 0 · eval defects 53 · unknown 0/);
  });
});

describe("S3: unit tests passed while real cross-system publication broke commit fencing", () => {
  const fencing = (verify, ref, extra = {}) => {
    const t = task("high");
    t.criteria[1] = { ...t.criteria[1], verify };
    t.evidence["T-1.2"] = [ref];
    return { t, head: taskFiles(t, extra) };
  };
  test("a critical safety invariant can't be verified by a unit test", async () => {
    const { head } = fencing("unit", "test:src/publish.test.ts#rejected commit leaves nothing");
    const r = await evaluate(ctx({ head, body: "Flow-Task: T-1" }));
    assert.ok(has(r, "a critical safety invariant needs integration, e2e, failure_injection, eval verification, not unit"));
  });
  test("calling a unit test failure_injection doesn't work either: the ref must live where fault tests live", async () => {
    const { head } = fencing("failure_injection", "test:src/publish.test.ts#rejected commit leaves nothing", { "src/publish.test.ts": 'test("rejected commit leaves nothing", () => { expect(mockWriter.calls).toBe(0); })' });
    assert.ok(has(await evaluate(ctx({ head, body: "Flow-Task: T-1", checks: green("db-tests") })), "is not where failure_injection tests live"));
  });
  test("a real fault-injection test that exists and isn't skipped proves it", async () => {
    const t = task("high");
    const head = taskFiles(t);
    const c = ctx({ head, body: "Flow-Task: T-1", checks: green("db-tests") });
    const r = await evaluate({ ...c, comments: approved(t, head, c.files) });
    assert.equal(r.ok, true, r.blockers.join("\n"));
  });
});

describe("S4: parallel PRs progressed without combined verification or a paired deploy", () => {
  const reader = (integration, evidenceIntegration) => {
    const t = task("medium", { integration, evidence: { ...task("medium").evidence, ...(evidenceIntegration ? { integration: evidenceIntegration } : {}) } });
    return taskFiles(t, { "src/e2e/reader-writer.e2e.ts": 'test("writer output is read back", async () => {})' });
  };
  const full = { owner: "builder-a", dependsOn: ["W-1"], deployPlan: "Deploy the writer first, then the reader, same hour" };
  const run = (head, base = {}, prs = {}) => evaluate(ctx({ head, base, prs, body: "Flow-Task: T-1", checks: green("db-tests") }));

  test("the reader can't merge before the writer's PR merged", async () => {
    assert.ok(has(await run(reader(full, ["test:src/e2e/reader-writer.e2e.ts#writer output is read back"])), "W-1, which is not merged yet"));
    const writerSpecOnly = { ".flow/tasks/W-1/task.json": JSON.stringify({ ...task("medium", { id: "W-1" }), pr: 5 }) };
    assert.ok(has(await run(reader(full, ["test:src/e2e/reader-writer.e2e.ts#writer output is read back"]), writerSpecOnly, { "acme/app#5": { merged: false, body: "Flow-Task: W-1" } }), "PR #5 is not merged"));
    assert.ok(has(await run(reader(full, ["test:src/e2e/reader-writer.e2e.ts#writer output is read back"]), writerSpecOnly, { "acme/app#5": { merged: true, body: "unrelated" } }), "is not that task's PR"));
  });

  test("combined-system evidence and a deploy plan are required", async () => {
    const writer = { ".flow/tasks/W-1/task.json": JSON.stringify({ ...task("medium", { id: "W-1" }), pr: 5 }) };
    const prs = { "acme/app#5": { merged: true, body: "Flow-Task: W-1" } };
    assert.ok(has(await run(reader({ ...full, deployPlan: undefined }), writer, prs), "deployPlan is required"));
    assert.ok(has(await run(reader(full), writer, prs), "no combined-system evidence"));
    const ok = await run(reader(full, ["test:src/e2e/reader-writer.e2e.ts#writer output is read back"]), writer, prs);
    assert.equal(ok.ok, true, ok.blockers.join("\n"));
    assert.equal(ok.stages.integrated, "pass");
  });

  test("a cross-repo dependency must be a merged PR the gate can read", async () => {
    const cross = { ...full, dependsOn: ["acme/lindy#34725"] };
    const head = reader(cross, ["test:src/e2e/reader-writer.e2e.ts#writer output is read back"]);
    assert.ok(has(await run(head), "can't read"));
    assert.ok(has(await run(head, {}, { "acme/lindy#34725": { merged: false, body: "" } }), "not merged"));
    assert.equal((await run(head, {}, { "acme/lindy#34725": { merged: true, body: "" } })).ok, true);
  });
});

describe("S5: progress reported as activity, not verified outcomes", () => {
  const t = task("medium", { criteria: [...task("medium").criteria, { id: "T-1.3", kind: "operational", severity: "critical", verify: "canary", behavior: "p95 first useful memory under 10 minutes for 50 pilot users" }] });
  const head = taskFiles(t);

  test("merged is not deployed: without a deployment record, deployed is unknown", async () => {
    const r = await evaluate(ctx({ head, body: "Flow-Task: T-1", checks: green("db-tests"), merged: true, comments: [comment("agent-bot", "/flow release T-1 env=production sha=abc evidence=https://x")] }));
    assert.equal(r.stages.merged, "pass");
    assert.equal(r.stages.deployed, "unknown");
    const out = render(r);
    assert.match(out, /✅ merged → ❔ deployed/);
    assert.match(out, /T-1\.3 \(canary, after deploy\)/);
  });

  test("a GitHub deployment of the merge commit is what makes it deployed", async () => {
    const r = await evaluate(ctx({ head, body: "Flow-Task: T-1", checks: green("db-tests"), merged: true, deployments: [{ environment: "production", state: "success" }] }));
    assert.equal(r.stages.deployed, "pass: production");
  });

  test("a failing or running CI shows as such, never as tested", async () => {
    const running = await evaluate(ctx({ head, body: "Flow-Task: T-1", checks: [{ name: "db-tests", conclusion: "success" }, { name: "e2e", status: "in_progress", conclusion: null }] }));
    assert.equal(running.stages.tested, "running");
  });

  test("an unconfigured repo can't look green", async () => {
    const r = await evaluate({ ...ctx(), config: { ...CONFIG, approvers: [] } });
    assert.equal(r.ok, false);
  });
});
