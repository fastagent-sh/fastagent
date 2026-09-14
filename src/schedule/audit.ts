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
  /**
   * `deferred` = a wake into a busy session, re-scheduled (not a final outcome for that wake-up).
   * `stale` = a slot that arrived after the schedule had already claimed a later one, so it will never run — a
   * planned turn missing from the bill, which is why it is here rather than only in a log.
   * `interrupted` = a CRON fire the process stopped in the middle of, written by the NEXT boot from the slot claim it
   * left in `schedule/claims/` (the run that owned it never got to write anything). A killed WAKE-UP produces
   * nothing: `takeFirstDueWakeup` removes it from the store before the turn starts, so no claim survives.
   */
  outcome: "completed" | "failed" | "deferred" | "interrupted" | "stale";
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

function readAudit(stateRoot: string): string {
  try {
    return readFileSync(runsPath(stateRoot), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(`run audit ${runsPath(stateRoot)} is unreadable: ${String(e)}`, { cause: e });
  }
}

// A JSON string escapes every quote it contains, so these byte sequences cannot occur inside a recorded reply — the
// first match on a line is always that line's own field, whatever order the writer emits fields in.
const NAME = /"name":("(?:[^"\\]|\\.)*")/;
const FIRED_AT = /"firedAt":"([^"]+)"/;

/**
 * The latest `firedAt` for each of `names`, reading the lines but parsing no records: the audit is append-only and
 * never rotated, and a `completed` line carries the turn's whole reply, so the boot-time claim check must not parse
 * a year of them (`readRuns` is for a history the operator asked to see).
 *
 * Names are matched in the ESCAPED spelling `appendRun`'s `JSON.stringify` produced, so a schedule whose filename
 * contains `"` or `\` still matches its own records instead of never matching.
 */
export function latestFiredAt(stateRoot: string, names: Iterable<string>): Map<string, string> {
  const wanted = new Map([...names].map((name) => [JSON.stringify(name), name]));
  const latest = new Map<string, string>();
  for (const line of readAudit(stateRoot).split("\n")) {
    const name = wanted.get(NAME.exec(line)?.[1] ?? "");
    const firedAt = FIRED_AT.exec(line)?.[1];
    if (name === undefined || firedAt === undefined) continue;
    const previous = latest.get(name);
    if (previous === undefined || firedAt > previous) latest.set(name, firedAt);
  }
  return latest;
}

/** Read the run history (optionally filtered by name), oldest first. */
export function readRuns(stateRoot: string, name?: string): RunRecord[] {
  const records: RunRecord[] = [];
  for (const line of readAudit(stateRoot).split("\n")) {
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
