/** Durable scheduler state under `<stateRoot>/schedule/`. */
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
 * How many claims to keep per schedule — and therefore how far back `fastagent routine history` can see, since
 * the claims ARE the history. The gate below reads only the newest, so this number answers the history's question,
 * "did last night's run silently fail?": at 512 a minute cron keeps ~8.5 hours, an hourly one ~3 weeks.
 *
 * Raise it by FILE COUNT, not by byte count: 512 short lines are ~25 KB of content but ~2 MiB of blocks and 512
 * inodes per schedule on a 4 KiB-block filesystem. Pruning removes the OLDEST names only, so the newest claim never
 * goes — which is what keeps the gate working past the window.
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
 * It has to be asked because a claims directory is a directory, and a foreign name breaks things two ways. A name
 * that sorts AFTER every real claim (`<slot>.tmp`, an editor's `<slot>~`) would be read as the newest one — which
 * decides whether the next slot is refused as stale, where catch-up resumes, and which fire the boot reconciler
 * settles. Any other name (`.DS_Store`, which sorts before all of them) cannot be turned back into a slot instant,
 * and the reconciler's `new Date(fire.slot)` on it throws `RangeError: Invalid time value` out of `start()`.
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
/**
 * How a claimed occurrence ended.
 *
 * `skipped` is NOT a failure and is the reason this is an enum rather than a boolean: a schedule's turns share one
 * `routine:<name>` session, so an occurrence arriving while the previous one is still running is refused by that
 * session, and recording it as `failed` made "the last run was still going" indistinguishable from "the model call
 * died" — two things an operator reacts to completely differently. Every scheduler names this: Kubernetes calls it
 * `concurrencyPolicy: Forbid`, Temporal calls it the `Skip` overlap policy, and neither treats it as an error.
 */
export type FireOutcome = "completed" | "failed" | "skipped" | "interrupted";

/** One fired slot, as its claim file records it. `outcome` absent = claimed, never settled. */
export interface Fire {
  /** The slot this fire was FOR (the claim's name). */
  slot: string;
  /** When the claim was taken (falls back to `slot` when the stamp is unusable). */
  firedAt: string;
  outcome?: FireOutcome;
  ms?: number;
}

const isOutcome = (s: unknown): s is FireOutcome =>
  s === "completed" || s === "failed" || s === "skipped" || s === "interrupted";

/**
 * Read one claim file: `{"firedAt":"…"}`, plus `outcome` and `ms` once the turn has reported.
 *
 * JSON, and not a line this module splits itself, because the write is deliberately not atomic (`settleClaim` may
 * not leave a temp file in the directory `claimSlot` lists). A torn write must therefore be DETECTABLE, and that is
 * exactly what JSON gives for free: half an object does not parse, so a partially written claim reads as unsettled
 * — the safe state this design already handles — instead of as a record whose third field happened to look like a
 * number. The positional form cost two shipped bugs of that shape (a torn duration read as `0ms`, an absent one
 * coerced to the same), and the next field anyone adds would inherit them.
 *
 * Anything unusable — a torn write, a missing stamp, a date that is not one — falls back to the slot instant in the
 * file name. That is the earliest moment the fire can have happened, so the only degradation is catching up one run
 * that already ran: too many rather than too few.
 */
function parseClaim(raw: string, dir: string, name: string): Fire {
  const fire: Fire = { slot: slotInstant(name), firedAt: slotInstant(name) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  // `null` and a bare `12` parse FINE and are not records — destructuring them throws, and this runs on the
  // synchronous boot path, so the throw would be a service that does not start over one unreadable file. Empty is
  // ordinary (the process died between `openSync` creating the claim and the stamp being written), and so is an
  // earlier format's bare timestamp, which is why the rest is debug: the consequence is already visible as a fire
  // that reads `unreported`.
  if (parsed === null || typeof parsed !== "object") {
    if (raw.trim() !== "") {
      log.debug(`[schedule] claim ${join(dir, name)} is not a claim record (torn write, or an earlier format)`);
    }
    return fire;
  }
  const { firedAt, outcome, ms } = parsed as Record<string, unknown>;
  if (typeof firedAt === "string" && !Number.isNaN(Date.parse(firedAt))) fire.firedAt = firedAt;
  else log.warn(`[schedule] claim ${join(dir, name)} carries an unreadable stamp — using the slot instant`);
  if (isOutcome(outcome)) {
    fire.outcome = outcome;
    // A settled fire may carry NO duration: nobody timed an `interrupted` one (see `settleClaim`). Absent stays
    // absent — `0` would print as a turn that really did finish instantly, the one value this record will not invent.
    if (typeof ms === "number" && Number.isFinite(ms)) fire.ms = ms;
  } else if (outcome !== undefined) {
    // A word we do not know is not an outcome: the fire reads as unsettled, which the next boot reports.
    log.warn(`[schedule] claim ${join(dir, name)} carries an unknown outcome — reading it as unsettled: ${outcome}`);
  }
  return fire;
}

function readClaim(dir: string, name: string): Fire | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, name), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e; // unreadable state (EACCES, EIO): the boot fails on it rather than running blind
  }
  return parseClaim(raw, dir, name);
}

/**
 * A schedule name becomes a path segment (its claims live in `claims/<name>/`), so the rule is exactly the safety
 * boundary and nothing more: a name may not leave that directory. The name comes from a filename under `routines/`,
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
 * `O_EXCL` is the whole mechanism: creating the file IS the decision, and the kernel gives it to exactly one creator,
 * even with a second scheduler on the same state (two `start`s, a restart overlapping its predecessor, an external
 * clock racing the resident one).
 *
 * Two ways to lose it, and both must hold beyond the pruning window: the slot's own claim exists, or a LATER slot has
 * already been claimed — a delivery older than the newest claim is a stale replay (AWS keeps retrying an event for up
 * to 24h), and firing it would bill a turn for an instant the schedule has already moved past.
 *
 * The claim carries the wall-clock instant it was taken (as `{"firedAt":"…"}`, the shape `settleClaim` writes the
 * outcome back into), so the next boot can tell a fire that never reported from one that did
 * (`markInterruptedFire`) without depending on a second file being written after it.
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
    writeFileSync(fd, JSON.stringify({ firedAt: firedAt.toISOString() }));
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
 * which is why there is no separate audit file to rotate (what the turn SAID is in its session, not here).
 *
 * THE HISTORY read, and its only caller is the read-only `routine history` — which translates a read fault into a
 * one-line refusal. The serving boot reads `latestFire` instead: it asks about ONE claim, and a window of files kept
 * for an operator to look at has no business deciding whether a service starts.
 */
export function readFires(stateRoot: string, name: string): Fire[] {
  const dir = claimDir(stateRoot, name);
  // A claim pruned between the listing and the read is not a fire this state root still keeps, so it is dropped
  // rather than reported as an unsettled one — which is what `unreported` would claim about a run nobody skipped.
  return listClaims(dir).flatMap((slot) => readClaim(dir, slot) ?? []);
}

/**
 * The NEWEST fire recorded for `name` — the one claim the serving boot reads, for the two planes that must agree
 * about it: where catch-up resumes (`firedAt`) and whether that fire ever reported (`outcome`). Deriving those
 * separately is how they come to disagree about the same file.
 *
 * Only the newest matters to either. A schedule's resident loop runs one turn at a time, so it can leave at most one
 * unsettled claim behind; an older unsettled one needs a second writer, and the second-writer topology (an external
 * clock) skips the reconciler entirely. Reading the whole retained window here would instead make a file that is
 * 400 fires old — kept only so an operator can look at it — able to fail a boot.
 *
 * A read fault on THIS claim stays fatal: it decides the stale gate and the resume point, and running blind on it
 * fires a slot twice or never.
 */
export function latestFire(stateRoot: string, name: string): Fire | undefined {
  const dir = claimDir(stateRoot, name);
  for (const slot of listClaims(dir).reverse()) {
    // `undefined` = pruned between the listing and the read; the one before it is then the newest that still exists.
    const fire = readClaim(dir, slot);
    if (fire !== undefined) return fire;
  }
  return undefined;
}

/**
 * Write back how the claimed fire ended, into the claim file itself.
 *
 * The SAME file, because a second one would reintroduce the window this whole design closes: a killed process would
 * leave a claimed slot that nothing accounts for. An unsettled claim IS the record of an interrupted fire.
 *
 * NOT `writeFileAtomic`: its temp would land in the directory `claimSlot` lists (`<slot>.tmp` is not a claim name,
 * so `listClaims` skips a leftover one, but the rename would still be a second writer of the same directory for no
 * gain) — and a rename would re-create a name a concurrent prune had just removed, which the open below exists to
 * prevent. A torn write degrades the way an unusable stamp already does (`parseClaim`) — the slot is re-read as
 * unsettled, which is visible, not lost.
 */
export function settleClaim(stateRoot: string, name: string, slot: Date, outcome: FireOutcome, ms?: number): void {
  const dir = claimDir(stateRoot, name);
  const file = claimName(slot);
  let fd: number;
  try {
    // `r+`, so this can only ever write a claim that EXISTS. A concurrent `claimSlot` may prune this slot while its
    // turn is still running; reading first and then writing by path would put the pruned file back — a fire in the
    // history that this state root had already decided to forget. Held open, a later unlink leaves the writes on a
    // dead inode instead, which is exactly the outcome being dropped along with the slot.
    fd = openSync(join(dir, file), "r+");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // pruned: the outcome goes with the slot, silently
    // EACCES/EIO. The fire happened; killing the schedule's loop over its bookkeeping would cost every later fire
    // too, so this is reported instead. The outcome is then lost: the slot stays `unreported` in the history, and
    // the next boot settles it as `interrupted` ONLY if it is still the newest claim by then (`markInterruptedFire`
    // reads that one) — a later fire on the same schedule leaves it unreported for good.
    log.warn(`[schedule] ${name}: could not open the claim for slot ${file} to settle it: ${String(e)}`);
    return;
  }
  try {
    // The stamp is preserved, not rewritten: `firedAt` is what catch-up resumes from. A duration is written only
    // when one was measured: nobody timed an `interrupted` fire, and writing `0` for it would print as a turn that
    // took no time — the same false value the history deliberately leaves blank.
    const claimed = parseClaim(readFileSync(fd, "utf8"), dir, file);
    const record = { firedAt: claimed.firedAt, outcome, ...(ms === undefined ? {} : { ms: Math.round(ms) }) };
    // Truncate first: a shorter record would otherwise leave the old tail behind. With JSON that tail can only
    // produce a parse failure rather than a plausible field, but a file that says one thing is still worth having.
    ftruncateSync(fd, 0);
    writeSync(fd, JSON.stringify(record), 0);
  } catch (e) {
    // Housekeeping: the turn itself already happened. The outcome is lost the same way the open failure above
    // loses it — `unreported` in the history, settled as `interrupted` by the next boot only while it is still the
    // newest claim.
    log.warn(`[schedule] ${name}: could not record the ${outcome} outcome of slot ${file}: ${String(e)}`);
  } finally {
    closeSync(fd);
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
