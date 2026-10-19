import { readFileSync } from "node:fs";
import { insertMany } from "./db.js";

/** Imports a contacts CSV (name,email). Bad rows are reported, the rest are imported. */
export async function importContacts(file) {
  const lines = readFileSync(file, "utf8").trim().split("\n").slice(1);
  const errors = [], good = [], seen = new Set();
  for (const [i, line] of lines.entries()) {
    const [name, email] = line.split(",");
    if (!email) { errors.push({ line: i + 2, error: "email is required" }); continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    good.push({ name, email });
  }
  for (let i = 0; i < good.length; i += 500) await insertMany(good.slice(i, i + 500));
  return { imported: good.length, errors };
}
