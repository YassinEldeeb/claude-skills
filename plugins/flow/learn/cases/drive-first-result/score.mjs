// Scorer for drive-first-result: a flow 2.2 acceptance check, not a comparison (master never asked for rounds).
// Pass only when all hold:
//   (a) .flow/tasks/<ID>/progress.md has a round whose `artifact:` names a file or directory that exists and whose
//       `result:` says what happened (a plan-only round, "will ...", "TBD", fails);
//   (b) the work went on past that checkpoint in the same session: verify.md ends with a verdict and getForecast
//       caches (the medium case's own end state);
//   (c) the final message doesn't ask whether to continue.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const PLAN = /^(tbd|todo|pending|n\/a|none|not (yet )?(run|started|done)|will\b|plan(ned)?\b|to do\b|to be\b)/i;
const ASKS = /\b(shall|should|do you want me to|want me to|would you like me to)\b[^.?\n]{0,40}\b(continue|proceed|go on|keep going)\b[^.\n]*\?/i;

export async function score(input) {
  const { dir, result } = input;
  const problems = [];
  const tasksDir = join(dir, ".flow/tasks");
  const ids = existsSync(tasksDir) ? readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, "progress.md"))) : [];
  if (!ids.length) problems.push("no progress.md");
  else {
    const text = readFileSync(join(tasksDir, ids[0], "progress.md"), "utf8");
    const rounds = text.split(/^##\s+/m).slice(1);
    const field = (round, name) => new RegExp(`^\\s*-\\s*${name}:\\s*(.+)$`, "im").exec(round)?.[1]?.trim() ?? "";
    const paths = (value) => [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]).concat(value.split(/[\s,;()]+/)).map((p) => p.replace(/^\.\//, "").replace(/[`.:]+$/, "")).filter((p) => p && !/^https?:/.test(p));
    const real = rounds.filter((r) => {
      const artifact = field(r, "artifact"), res = field(r, "result");
      const exists = paths(artifact).some((p) => existsSync(join(dir, p)) || existsSync(join(tasksDir, ids[0], p)));
      return exists && res && !PLAN.test(res);
    });
    if (!rounds.length) problems.push("progress.md has no round");
    else if (!real.length) problems.push("no round with an existing artifact and a result (plans only)");
  }
  // The medium case's end state is the "went on past the checkpoint" part.
  const { score: medium } = await import(join(here, "../drive-medium-forecast/score.mjs"));
  const end = await medium(input);
  if (!end.pass) problems.push(`didn't finish: ${end.details}`);
  const said = String(result?.result ?? "");
  if (ASKS.test(said)) problems.push(`asks to continue: "${ASKS.exec(said)[0].slice(0, 80)}"`);
  return problems.length ? { pass: false, details: problems.join("; ") } : { pass: true, details: `round with artifact in ${ids[0]}; finished` };
}
