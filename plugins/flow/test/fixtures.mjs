// Test fixtures: an in-memory PR (head and protected-branch files, comments, checks) fed straight to evaluate().
import { readFileSync } from "node:fs";
import { specDocPaths, specHash } from "../gate/lib.mjs";

const template = JSON.parse(readFileSync(new URL("../templates/config.json", import.meta.url), "utf8"));
export const CONFIG = { ...template, approvers: ["alice"], agents: ["agent-bot"], verify: { ...template.verify, integration: { paths: ["**/*.int.test.*"], checks: ["db-tests"] } } };
export const HEAD = "a".repeat(40);

/** A complete, valid task of the given tier, plus the files it needs. Override fields to break one thing at a time. */
export function task(tier, overrides = {}) {
  const id = overrides.id ?? "T-1";
  const base = {
    schema: 1, id, title: "Recent-first memory bootstrap", tier,
    signals: tier === "high" ? ["worker"] : tier === "medium" ? ["prompt"] : [],
    outcome: "A new user gets a useful memory from recent history within 10 minutes",
    criteria: [
      { id: `${id}.1`, kind: "functional", severity: "critical", verify: "integration", behavior: "The first turn after bootstrap reads a recent memory" },
      ...(tier === "high" ? [{ id: `${id}.2`, kind: "safety", severity: "critical", verify: "failure_injection", behavior: "A rejected commit never leaves a published file" }] : []),
    ],
    evidence: {
      [`${id}.1`]: ["test:src/bootstrap.int.test.ts#reads a recent memory"],
      ...(tier === "high" ? { [`${id}.2`]: ["test:src/publish.fault.test.ts#rejected commit leaves nothing"] } : {}),
    },
  };
  if (tier !== "small") base.challenge = { simplest: "Reuse the per-message writer on 14 days of history", failureModes: ["Rate limits stretch the bootstrap", "Backfill resurrects a forgotten fact"] };
  if (tier === "high") {
    base.challenge = {
      ...base.challenge,
      failureModes: [...base.challenge.failureModes, "Publication races the database commit"],
      existingMayBeWrong: "The writer assumes one source at a time",
      scale: "1,200 new users a week, 40 model calls each",
      e2eProof: "Real Postgres integration test plus a commit-kill fault test",
      alternatives: [{ name: "full history", why: "Hours before the first memory, 5x the cost" }, { name: "recent first", why: "Value in minutes; backfill optional", chosen: true }],
      assumptions: [{ text: "14 days hold a useful fact for most users", status: "verified", evidence: "Sampled 40 pilot users, 36 had one" }],
      review: "challenge-review.md",
    };
    base.capacity = {
      workload: { users: { value: 1200, source: "estimate", basis: "sales forecast per week" }, workPerUser: { value: "p95 900 sources", source: "measured", ref: "pilot query over 31 users", at: "2026-10-14" } },
      latency: { firstResult: { value: "p95 9 min", source: "estimate", basis: "40 calls x 6 s at concurrency 8" } },
      cost: { perUser: { value: "$0.04", source: "estimate", basis: "40 calls x 2.5k tokens" } },
      cut80: "Recent-first skips 85% of sources before the first memory",
    };
  }
  return { ...base, ...overrides };
}

/** Head files for a task: task.json, its docs and its test files. */
export function taskFiles(t, extra = {}) {
  const dir = `.flow/tasks/${t.id}`;
  return {
    [`${dir}/task.json`]: JSON.stringify(t, null, 2),
    [`${dir}/design.md`]: "Recent-first bootstrap: read 14 days, publish after commit, backfill later at low priority.",
    [`${dir}/challenge-review.md`]: "Independent review: alternatives compared, numbers checked.\nverdict: pass",
    [`${dir}/verify.md`]: "Verified against the diff and criteria.\nverdict: pass",
    "src/bootstrap.int.test.ts": 'test("reads a recent memory", async () => { expect(await firstTurn()).toBeTruthy(); });',
    "src/publish.fault.test.ts": 'test("rejected commit leaves nothing", async () => { expect(await published()).toBe(0); });',
    ...extra,
  };
}

export const hashOf = (t, head) => specHash(t, Object.fromEntries(specDocPaths(t).map((path) => [path, head[path] ?? null])));

/** A PR: files default to every head path that differs from base, as added or modified, with "+" patches. */
export function ctx({ head = {}, base = {}, files, body = "", author = "agent-bot", comments = [], checks = [], reviews = [], config = CONFIG, baseRoot = ["src", ".flow", ".github", "docs"], merged = false, deployments = [], prs = {}, prBase = "main", signatures = {} } = {}) {
  const changed = files ?? Object.keys(head).filter((path) => head[path] !== base[path]).map((path) => {
    const text = String(head[path]);
    return { filename: path, status: path in base ? "modified" : "added", patch: text.split("\n").map((l) => `+${l}`).join("\n"), additions: text.split("\n").length };
  });
  return {
    repo: "acme/app", defaultBranch: "main", config,
    pr: { number: 7, author, body, headSha: HEAD, base: prBase, merged },
    files: changed, baseRoot, comments, reviews, deployments,
    checks: checks.map((c) => ({ status: "completed", ...c })),
    read: async (path, side) => (side === "base" ? base : head)[path] ?? null,
    prState: async (repo, n) => prs[`${repo}#${n}`] ?? null,
    verifySignature: async (message, signature) => signatures[`${message}|${signature}`] ?? null,
  };
}

export const comment = (login, body, { edited = false, type = "User", id = 1 } = {}) => ({
  user: { login, id, type }, body, created_at: "2026-10-16T10:00:00Z", updated_at: edited ? "2026-10-16T10:05:00Z" : "2026-10-16T10:00:00Z",
});
export const green = (...names) => names.map((name) => ({ name, conclusion: "success" }));
