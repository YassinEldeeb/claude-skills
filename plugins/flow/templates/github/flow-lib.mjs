// flow: one parser for status.md and decisions.md, used by the plugin hooks and by the repo's CI check.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const readFile = (dir, name) => {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");
const PLACEHOLDER = /^(<.*>|tbd|none|pending|\?+|-+|n\/a)$/i;

/** A real approver name: not empty, not a placeholder. */
export const isApprover = (value) => !!value && !PLACEHOLDER.test(value.trim());

const cells = (line) => {
  const parts = line.trim().replace(/\\\|/g, "\u0000").split("|").map((cell) => cell.replace(/\u0000/g, "|").trim());
  return parts.slice(1, parts.length - 1); // drop the empty edges, keep empty middle cells
};

/** 🔴 rows of decisions.md that are not settled: status not approved/rejected/done, or approved with no approver. */
export function unsettledRedDecisions(text) {
  if (!text) return [];
  const rows = stripComments(text).split("\n").filter((line) => line.trim().startsWith("|"));
  const header = rows.length ? cells(rows[0]).map((cell) => cell.toLowerCase()) : [];
  const col = (name) => header.findIndex((cell) => cell.includes(name));
  const level = col("level"), status = col("status"), approver = col("approved");
  if (level < 0 || status < 0) return [];
  const out = [];
  for (const row of rows.slice(1)) {
    const c = cells(row);
    if (c.every((cell) => /^:?-*:?$/.test(cell))) continue; // separator row
    if (!(c[level] ?? "").includes("🔴")) continue;
    const state = (c[status] ?? "").replace(/[*`_]/g, "").trim().toLowerCase();
    const settled = /^(approved|rejected|done)\b/.test(state);
    const named = approver < 0 || isApprover(c[approver]);
    if (!settled || (state.startsWith("approved") && !named)) out.push(c.slice(0, 2).filter(Boolean).join(" "));
  }
  return out;
}

/** Items under "Changed:" in status.md without "approved by: <a real name>". */
export function unapprovedChanges(text) {
  if (!text) return [];
  const out = [];
  let inChanged = false;
  const check = (item) => {
    item = item.replace(/^\s*[-*]\s*/, "").trim();
    if (!item || /^none\.?$/i.test(item)) return;
    const match = item.match(/approved by\s*:\s*([^,;]+)/i);
    if (!match || !isApprover(match[1])) out.push(item);
  };
  for (const line of stripComments(text).split("\n")) {
    const key = line.match(/^\s*(?:#+\s*)?[*_]*\s*(\w[\w ]*?)\s*[*_]*\s*:\s*[*_]*\s*(.*)$/);
    if (key && /^changed$/i.test(key[1].trim())) { inChanged = true; check(key[2]); continue; }
    if (inChanged && (!line.trim() || /^\s*#/.test(line) || (key && !/^\s*[-*]/.test(line)))) { inChanged = false; continue; }
    if (inChanged) check(line);
  }
  return out;
}
