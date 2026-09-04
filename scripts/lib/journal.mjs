/**
 * Append-only event journal (data/journal.jsonl) - the raw material for the
 * daily report. One JSON object per line: { at, type, ...data }.
 */

import fs from "node:fs";
import path from "node:path";
import { dataDir, log } from "./mc.mjs";

const file = path.join(dataDir, "journal.jsonl");

export function note(type, data = {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), type, ...data }) + "\n");
  } catch (e) {
    log("journal write failed:", e.message);
  }
}

/** All entries newer than `sinceMs` (absolute timestamp). */
export function since(sinceMs) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.at >= sinceMs);
  } catch {
    return [];
  }
}

/**
 * Drop entries older than `keepMs` (default 14 days) to keep the file small.
 * Atomic (tmp + rename): a concurrent reader (e.g. the attest-report child)
 * sees either the old or the new file, never a truncated one.
 */
export function compact(keepMs = 14 * 24 * 3600_000) {
  try {
    const keep = since(Date.now() - keepMs);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join("\n") + (keep.length ? "\n" : ""));
    fs.renameSync(tmp, file);
  } catch { /* ignore */ }
}
