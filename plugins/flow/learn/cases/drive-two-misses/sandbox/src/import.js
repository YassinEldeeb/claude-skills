import { readFileSync } from "node:fs";
import { insert } from "./db.js";

const seen = new Map(); // dedupe cache (round 1)

/** Imports a contacts CSV (name,email). Bad rows are reported, the rest are imported. */
export async function importContacts(file) {
  const lines = readFileSync(file, "utf8").trim().split("\n").slice(1);
  const errors = [];
  let imported = 0;
  for (const [i, line] of lines.entries()) {
    const [name, email] = line.split(",");
    if (seen.has(email)) continue;
    try {
      await insert({ name, email });
      seen.set(email, true);
      imported++;
    } catch (error) {
      errors.push({ line: i + 2, error: error.message });
    }
  }
  return { imported, errors };
}
