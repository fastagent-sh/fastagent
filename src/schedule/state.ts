/** Durable scheduler state under `<stateRoot>/schedule/`. */
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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

/**
 * How many claims to keep per schedule. Pruning removes the OLDEST names only, so the newest claim always survives —
 * which is what keeps the monotonic gate below working past the window.
 */
const KEEP_CLAIMS = 32;

/** A slot instant as a filename (ISO minus the characters a path cannot carry); sorts in slot order. */
const claimName = (slot: Date): string => slot.toISOString().replace(/[:.]/g, "-");

/** This function builds a path from it, so a name that can leave `claims/<name>/` is a bug, not an input. */
function claimDir(stateRoot: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`refusing to build a claim path for the unsafe schedule name ${JSON.stringify(name)}`);
  }
  return join(stateRoot, "schedule", "claims", name);
}

export interface SlotClaim {
  /** The slot this claim is for, as its file name. */
  slot: string;
  /** Wall-clock time the claim was taken — what a run record must be at or after to account for it. */
  firedAt: string;
}

/**
 * Take a cron slot, or report that it is not ours to take.
 *
 * `O_EXCL` is the whole mechanism: creating the file IS the decision, and the kernel gives it to exactly one creator.
 * The read-modify-write of `fires.json` this replaced looked atomic in one process and was not across two, so a
 * second scheduler on the same state (two `start`s, a restart overlapping its predecessor, an external clock racing
 * the resident one) ran the same cron twice.
 *
 * Two ways to lose it, and both must hold beyond the pruning window: the slot's own claim exists, or a LATER slot has
 * already been claimed — a delivery older than the newest claim is a stale replay (AWS keeps retrying an event for up
 * to 24h), and firing it would bill a turn for an instant the schedule has already moved past.
 *
 * The claim carries the wall-clock instant it was taken, so the next boot can tell a fire that never reported from
 * one that did (`recordInterruptedFires`) without depending on a second file being written after it.
 */
export function claimSlot(stateRoot: string, name: string, slot: Date, firedAt: Date): boolean {
  const dir = claimDir(stateRoot, name);
  mkdirSync(dir, { recursive: true });
  const taken = readdirSync(dir).sort();
  const wanted = claimName(slot);
  const newest = taken.at(-1);
  if (newest !== undefined && wanted < newest) return false;
  let fd: number;
  try {
    fd = openSync(join(dir, wanted), "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e; // a real IO fault: the caller reports it and leaves the schedule armed
  }
  try {
    writeFileSync(fd, firedAt.toISOString());
  } finally {
    closeSync(fd);
  }
  pruneClaims(dir, taken);
  return true;
}

/** The newest claim (by slot) and when it was taken, or `undefined` when this schedule has never fired here. */
export function latestClaim(stateRoot: string, name: string): SlotClaim | undefined {
  let slot: string | undefined;
  try {
    slot = readdirSync(claimDir(stateRoot, name)).sort().at(-1);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (slot === undefined) return undefined;
  // An empty file is a claim whose process died between the create and the stamp: the slot itself is the earliest
  // instant the fire can have happened, which is the conservative stand-in.
  const stamped = readFileSync(join(claimDir(stateRoot, name), slot), "utf8").trim();
  return { slot, firedAt: stamped || slot.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z") };
}

function pruneClaims(dir: string, taken: readonly string[]): void {
  try {
    for (const stale of taken.slice(0, Math.max(0, taken.length + 1 - KEEP_CLAIMS))) unlinkSync(join(dir, stale));
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
