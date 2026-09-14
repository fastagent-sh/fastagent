/** Durable scheduler state under `<stateRoot>/schedule/`. */
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { log } from "../log.ts";

/** Path of a JSON file under `<stateRoot>/schedule/`. */
export function scheduleFile(stateRoot: string, name: string): string {
  return join(stateRoot, "schedule", `${name}.json`);
}

export function readScheduleFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`schedule state ${path} is unreadable — fix permissions/disk and restart: ${String(e)}`, {
      cause: e,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    log.warn(`[schedule] corrupt state file ${path} — ignoring: ${String(e)}`);
    return undefined;
  }
}

export function writeScheduleFile(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value));
}

// ── claims/: one file per fired slot — the DECISION to fire, made atomically ──

/** How many claims to keep per schedule. They exist to answer "was this slot taken", which only the recent ones can
 *  be asked about: `fires.json` already carries where catch-up resumes after downtime. */
const KEEP_CLAIMS = 32;

/** A slot instant as a filename (ISO minus the characters a path cannot carry). */
const claimName = (slot: Date): string => slot.toISOString().replace(/[:.]/g, "-");

/**
 * Take a cron slot, or report that someone else already has it.
 *
 * `O_EXCL` is the whole mechanism: creating the file IS the decision, and the kernel gives exactly one creator. The
 * read-modify-write of `fires.json` this replaced looked atomic in one process and was not across two, so a second
 * scheduler on the same state (two `start`s, a restart overlapping its predecessor) ran the same cron twice.
 *
 * A claim outliving its process is CORRECT here: the slot was taken, and a fire interrupted mid-turn is recorded as
 * `interrupted` by the next start rather than run again (see `recordInterruptedFires`).
 */
export function claimSlot(stateRoot: string, name: string, slot: Date): boolean {
  const dir = join(stateRoot, "schedule", "claims", encodeURIComponent(name));
  mkdirSync(dir, { recursive: true });
  try {
    closeSync(openSync(join(dir, claimName(slot)), "wx"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e; // a real IO fault: the caller reports it and leaves the schedule armed
  }
  pruneClaims(dir);
  return true;
}

function pruneClaims(dir: string): void {
  try {
    const names = readdirSync(dir).sort();
    for (const stale of names.slice(0, Math.max(0, names.length - KEEP_CLAIMS))) unlinkSync(join(dir, stale));
  } catch (e) {
    // Pruning is housekeeping: a failure leaves files behind, never an unclaimed slot.
    log.warn(`[schedule] could not prune fired-slot claims in ${dir}: ${String(e)}`);
  }
}

// ── fires.json: schedule name → last-fired ISO (where catch-up resumes after downtime) ──

/** name → last-fired ISO timestamp. */
export type Fires = Record<string, string>;

export function loadFires(stateRoot: string): Fires {
  const v = readScheduleFile(scheduleFile(stateRoot, "fires"));
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Fires) : {};
}

export function saveFires(stateRoot: string, fires: Fires): void {
  writeScheduleFile(scheduleFile(stateRoot, "fires"), fires);
}
