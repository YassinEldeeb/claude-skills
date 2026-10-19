import { readFileSync } from "node:fs";

/** A user's notes from the export: [{ id, user, text }]. */
export const readNotes = (file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
