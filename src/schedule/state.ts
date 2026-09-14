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
 * How many claims to keep per schedule. Only the newest is ever READ (the gate below and `latestFire`), so the rest
 * buy two things and nothing else: a reader that has already listed the directory is unlikely to have its pick
 * pruned out from under it (`latestFire` degrades rather than failing when that happens anyway), and an operator can
 * see the last slots this state root took. Pruning removes the OLDEST names only, so the newest claim never goes —
 * which is what keeps the gate working past the window.
 */
const KEEP_CLAIMS = 32;

/** A slot instant as a filename (ISO minus the characters a path cannot carry); sorts in slot order. */
const claimName = (slot: Date): string => slot.toISOString().replace(/[:.]/g, "-");

/**
 * A schedule name becomes a path segment (its claims live in `claims/<name>/`), so the rule is exactly the safety
 * boundary and nothing more: a name may not leave that directory. The name comes from a filename under `schedules/`,
 * which already cannot contain a separator — so what a stricter rule would actually reject is legal filenames
 * (`每日简报`, `my schedule`), whose only symptom would be a schedule that silently never fires again.
 *
 * One definition, two enforcers: `discover.ts` refuses an illegal one where the author can see which file is wrong,
 * and `claimDir` asserts it again for a programmatic caller.
 */
export function isSafeScheduleName(name: string): boolean {
  return name !== "" && !/[/\\]/.test(name) && !name.includes("\u0000") && name !== "." && name !== "..";
}

/** This function builds a path from it, so a name that can leave `claims/<name>/` is a bug, not an input. */
function claimDir(stateRoot: string, name: string): string {
  if (!isSafeScheduleName(name)) {
    throw new Error(`refusing to build a claim path for the unsafe schedule name ${JSON.stringify(name)}`);
  }
  return join(stateRoot, "schedule", "claims", name);
}

/**
 * Why a slot is not ours. `duplicate` is ordinary (the same delivery arrived twice, or another scheduler took it and
 * is running it now); `stale` means the schedule has moved past this instant and the slot will never run — a turn
 * missing from the bill, which reads differently in a log.
 */
export type SlotClaimOutcome =
  | { taken: true }
  /** The same delivery arrived twice, or another scheduler took this slot and may be running it now. */
  | { taken: false; why: "duplicate" }
  /** The schedule has moved past this instant: `newest` holds it, and this slot will never run. */
  | { taken: false; why: "stale"; newest: string };

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
export function claimSlot(stateRoot: string, name: string, slot: Date, firedAt: Date): SlotClaimOutcome {
  const dir = claimDir(stateRoot, name);
  mkdirSync(dir, { recursive: true });
  const taken = readdirSync(dir).sort();
  const wanted = claimName(slot);
  const newest = taken.at(-1);
  if (newest !== undefined && wanted < newest) return { taken: false, why: "stale", newest };
  let fd: number;
  try {
    fd = openSync(join(dir, wanted), "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { taken: false, why: "duplicate" };
    throw e; // a real IO fault: the caller reports it and leaves the schedule armed
  }
  try {
    writeFileSync(fd, firedAt.toISOString());
  } catch (e) {
    // The claim exists from `openSync` on, so a failed stamp (ENOSPC, EIO) would leave a slot that can only ever be
    // read as `duplicate` — taken, never run, never audited. Remove it so the failure this rethrows costs a retry
    // instead of the slot itself. The cleanup's own failure is reported but never replaces `e`: the caller needs
    // the reason the write failed, not the reason the rollback did.
    try {
      closeSync(fd);
      unlinkSync(join(dir, wanted));
    } catch (cleanup) {
      log.warn(
        `[schedule] ${name}: could not remove the unstamped claim ${wanted} — that slot is now taken but will never run: ${String(cleanup)}`,
      );
    }
    throw e;
  }
  closeSync(fd);
  pruneClaims(dir, taken);
  return { taken: true };
}

/**
 * When this schedule last fired here, from its newest claim — the ONE durable fact both planes read: the boot-time
 * reconciler (was that fire ever reported?) and catch-up (where does the next run resume from?).
 *
 * Pruning only ever removes the oldest names, so the newest claim is never the one that goes.
 *
 * An unusable stamp — empty because the process died between the create and the write, or not a date at all — falls
 * back to the slot instant in the file name. That is the earliest moment the fire can have happened, so the only
 * degradation is catching up one run that already ran: too many rather than too few.
 */
export function latestFire(stateRoot: string, name: string): string | undefined {
  let slot: string | undefined;
  try {
    slot = readdirSync(claimDir(stateRoot, name)).sort().at(-1);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (slot === undefined) return undefined;
  let stamped = "";
  try {
    stamped = readFileSync(join(claimDir(stateRoot, name), slot), "utf8").trim();
  } catch (e) {
    // Pruning by a concurrent claim can remove the name between the listing and this read. The slot in that name is
    // the fact we already have, so this is the same degradation an unusable stamp gets, not a boot failure.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (stamped && !Number.isNaN(Date.parse(stamped))) return stamped;
  if (stamped) log.warn(`[schedule] ${name}: claim ${slot} carries an unreadable stamp — using the slot instant`);
  return slot.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z");
}

function pruneClaims(dir: string, taken: readonly string[]): void {
  try {
    for (const stale of taken.slice(0, Math.max(0, taken.length + 1 - KEEP_CLAIMS))) unlinkSync(join(dir, stale));
  } catch (e) {
    // Pruning is housekeeping: a failure leaves files behind, never an unclaimed slot.
    log.warn(`[schedule] could not prune fired-slot claims in ${dir}: ${String(e)}`);
  }
}
