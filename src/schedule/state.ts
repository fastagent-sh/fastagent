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
 * How many claims to keep per schedule — and therefore how far back `fastagent schedule history` can see, since
 * the claims ARE the history.
 *
 * The gate below reads only the newest, so this number is set by the QUESTION the history exists to answer: "did
 * last night's run silently fail?". At 512 a minute cron keeps ~8.5 hours, a five-minute one ~1.8 days, an hourly
 * one ~3 weeks. A claim is one short line, so the whole window is tens of kilobytes — still bounded by construction,
 * which is the property that matters, rather than by a retention policy someone has to run.
 *
 * Pruning removes the OLDEST names only, so the newest claim never goes — which is what keeps the gate working
 * past the window.
 */
const KEEP_CLAIMS = 512;

/** A slot instant as a filename (ISO minus the characters a path cannot carry); sorts in slot order. */
const claimName = (slot: Date): string => slot.toISOString().replace(/[:.]/g, "-");

/** The instant a claim's file name stands for — `claimName` read backwards. */
const slotInstant = (name: string): string => name.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z");

/**
 * Is this file name one `claimName` produced? Defined by the round trip, so the answer is exactly "this is a slot
 * instant this code could have written", with no second spelling to keep in sync.
 *
 * It has to be asked because a claims directory is a directory: a `.DS_Store`, an editor backup or a half-finished
 * copy would otherwise sort after every real claim and be read as the newest one — which decides whether the next
 * slot is refused as stale, where catch-up resumes, and which fire the boot reconciler settles.
 */
const isClaimName = (name: string): boolean => {
  const instant = Date.parse(slotInstant(name));
  return !Number.isNaN(instant) && claimName(new Date(instant)) === name;
};

/**
 * THE listing of a claims directory: claim files only, oldest slot first. Every reader goes through it — the gate,
 * the history, and the pruning — so "what counts as a claim" is decided once instead of by whoever reads next.
 */
function listClaims(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // never fired here yet
    throw e; // unreadable state: the boot fails on it rather than running blind
  }
  const claims: string[] = [];
  for (const name of names.sort()) {
    if (isClaimName(name)) claims.push(name);
    // Not an error of ours and not the operator's to fix on a schedule's behalf (macOS writes `.DS_Store` into any
    // directory someone opens), so it is skipped at debug level rather than warned about on every single fire.
    else log.debug(`[schedule] ignoring ${join(dir, name)}: not a fired-slot claim`);
  }
  return claims;
}

/**
 * How a fired slot ended. There is no `deferred` or `stale` here because neither has a claim: a deferred wake-up was
 * never claimed, and a stale delivery is refused before one is taken. Both are log lines.
 */
export type FireOutcome = "completed" | "failed" | "interrupted";

/** One fired slot, as its claim file records it. `outcome` absent = claimed, never settled. */
export interface Fire {
  /** The slot this fire was FOR (the claim's name). */
  slot: string;
  /** When the claim was taken (falls back to `slot` when the stamp is unusable). */
  firedAt: string;
  outcome?: FireOutcome;
  ms?: number;
}

const isOutcome = (s: string | undefined): s is FireOutcome =>
  s === "completed" || s === "failed" || s === "interrupted";

/**
 * Read one claim file: `<firedAt>`, or `<firedAt> <outcome> <ms>` once the turn has reported. `undefined` means the
 * file is GONE — a concurrent claim pruned it between the listing and this read.
 *
 * That case is distinct from "exists but unsettled" and must stay distinct: the reconciler settles what it finds
 * unsettled, and `settleClaim` CREATES the file it writes, so treating a pruned claim as unsettled would resurrect
 * an old slot and invent an `interrupted` fire for a run that finished long ago.
 *
 * An unusable stamp — empty because the process died between the create and the write, or not a date at all — falls
 * back to the slot instant in the file name. That is the earliest moment the fire can have happened, so the only
 * degradation is catching up one run that already ran: too many rather than too few.
 */
function readClaim(dir: string, name: string): Fire | undefined {
  const slot = slotInstant(name);
  let raw = "";
  try {
    raw = readFileSync(join(dir, name), "utf8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e; // unreadable state (EACCES, EIO): the boot fails on it rather than running blind
  }
  const [stamp, outcome, ms] = raw.split(/\s+/);
  const fire: Fire = { slot, firedAt: slot };
  if (stamp && !Number.isNaN(Date.parse(stamp))) fire.firedAt = stamp;
  else if (stamp) log.warn(`[schedule] claim ${join(dir, name)} carries an unreadable stamp — using the slot instant`);
  if (isOutcome(outcome)) {
    fire.outcome = outcome;
    fire.ms = Number(ms) || 0;
  } else if (outcome) {
    // A word we do not know is not an outcome: the fire reads as unsettled, which the next boot reports.
    log.warn(`[schedule] claim ${join(dir, name)} carries an unknown outcome — reading it as unsettled: ${outcome}`);
  }
  return fire;
}

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
 * one that did (`markInterruptedFires`) without depending on a second file being written after it.
 */
export function claimSlot(stateRoot: string, name: string, slot: Date, firedAt: Date): SlotClaimOutcome {
  const dir = claimDir(stateRoot, name);
  mkdirSync(dir, { recursive: true });
  const taken = listClaims(dir);
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
    // read as `duplicate` — taken, never run, never reported. Remove it so the failure this rethrows costs a retry
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
 * Every fire this state root still keeps for `name`, oldest first — bounded by `KEEP_CLAIMS` because the claims ARE
 * the history. Nothing here grows: the pruning that keeps the claim gate cheap keeps the history's size fixed too,
 * which is why there is no separate audit file to rotate (the turn's own narrative is a log line, and rotating logs
 * is the platform's job — 12-factor XI).
 *
 * THE read for both planes that ask about past fires: where catch-up resumes (`.at(-1)`) and which fires were never
 * reported. Deriving those separately is how they come to disagree about the same directory.
 */
export function readFires(stateRoot: string, name: string): Fire[] {
  const dir = claimDir(stateRoot, name);
  // A claim pruned between the listing and the read is not a fire this state root still keeps — dropping it is what
  // keeps the reconciler from settling (and so re-creating) a slot that is already gone.
  return listClaims(dir).flatMap((slot) => readClaim(dir, slot) ?? []);
}

/**
 * Write back how the claimed fire ended, into the claim file itself.
 *
 * The SAME file, because a second one would reintroduce the window this whole design closes: a killed process would
 * leave a claimed slot that nothing accounts for. An unsettled claim IS the record of an interrupted fire.
 *
 * NOT `writeFileAtomic`: its temp would land in the directory `claimSlot` lists (`<slot>.tmp` is not a claim name,
 * so `listClaims` skips a leftover one, but the rename would still be a second writer of the same directory for no
 * gain). A torn write degrades the way an unusable stamp already does (`readClaim`) — the slot is re-read as
 * unsettled, which is visible, not lost.
 */
export function settleClaim(stateRoot: string, name: string, slot: Date, outcome: FireOutcome, ms: number): void {
  const dir = claimDir(stateRoot, name);
  const file = claimName(slot);
  try {
    const claimed = readClaim(dir, file);
    // Gone means a concurrent claimer pruned this slot while its turn was still running. Writing would RE-CREATE
    // the file pruning just removed — the same rule `readClaim` states for the reconciler, applied to its other
    // caller. The outcome is lost with the slot, which is what pruning already decided.
    if (claimed === undefined) return;
    // The stamp is preserved, not rewritten: `firedAt` is what catch-up resumes from.
    writeFileSync(join(dir, file), `${claimed.firedAt} ${outcome} ${Math.round(ms)}`);
  } catch (e) {
    // Housekeeping, like the pruning below: the turn itself already happened, and the worst case is that the next
    // boot reports this fire as interrupted.
    log.warn(`[schedule] ${name}: could not record the ${outcome} outcome of slot ${file}: ${String(e)}`);
  }
}

function pruneClaims(dir: string, taken: readonly string[]): void {
  try {
    for (const stale of taken.slice(0, Math.max(0, taken.length + 1 - KEEP_CLAIMS))) unlinkSync(join(dir, stale));
  } catch (e) {
    // Pruning is housekeeping: a failure leaves files behind, never an unclaimed slot.
    log.warn(`[schedule] could not prune fired-slot claims in ${dir}: ${String(e)}`);
  }
}
