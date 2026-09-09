/**
 * The scheduler's run audit: ONE line per fired turn in `<stateRoot>/schedule/runs.jsonl` — the answer to cron's
 * classic pain, "did last night's run silently fail?".
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../log.ts";

export interface RunRecord {
  /** The schedule's name for a cron fire; `"wake"` for a self-scheduled wake-up (its session tells which). */
  name: string;
  session: string;
  firedAt: string; // ISO
  ms: number;
  /** `deferred` = a wake into a busy session, re-scheduled (not a final outcome for that wake-up). */
  outcome: "completed" | "failed" | "deferred";
  /** The turn's full reply text (completed). */
  reply?: string;
  /** The failure details (failed). */
  error?: string;
}

function runsPath(stateRoot: string): string {
  return join(stateRoot, "schedule", "runs.jsonl");
}

export function appendRun(stateRoot: string, record: RunRecord): void {
  try {
    const path = runsPath(stateRoot);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch (e) {
    log.warn(`[schedule] could not append the run audit (the fire itself is unaffected): ${String(e)}`);
  }
}

/** Read the run history (optionally filtered by name), oldest first. */
export function readRuns(stateRoot: string, name?: string): RunRecord[] {
  let raw: string;
  try {
    raw = readFileSync(runsPath(stateRoot), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`run audit ${runsPath(stateRoot)} is unreadable: ${String(e)}`, { cause: e });
  }
  const records: RunRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as RunRecord;
      if (typeof r.name !== "string" || typeof r.firedAt !== "string" || typeof r.outcome !== "string") {
        throw new Error("missing fields");
      }
      if (name === undefined || r.name === name) records.push(r);
    } catch {
      log.warn(`[schedule] skipping a malformed run-audit line: ${line.slice(0, 80)}`);
    }
  }
  return records;
}
