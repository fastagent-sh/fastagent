/**
 * THE CALLER'S OWN DEDUP KEY, for the route nobody authenticates.
 *
 * `POST /trigger` is an API: someone else's clock, CI job or button says "run this declared unit of work". It is
 * not a time trigger, so it has no occurrence to key on — the only thing that can tell one logical call from a
 * RETRY of that call is a token the caller mints and repeats, which is what every payments API does and what
 * EventBridge, Cloudflare and Railway all leave to the target.
 *
 * OPAQUE, and that is the whole point. Nothing here parses, orders or compares the key to a clock: an instant used
 * as a key was tried and cost four rounds of defences, because a number the receiver INTERPRETS is a number it has
 * to police (one dated ahead poisoned the claim gate forever, one off the grid minted a claim no occurrence
 * matched, an old one replayed history). A hash has no future, no order and no grid.
 *
 * `O_EXCL`, not read-then-write: creating the file IS the decision, the same way `claimSlot` works. The race it
 * guards is between PROCESSES over one state root — a restart overlap, two containers on a shared volume — and NOT
 * between two requests in this one: everything here is synchronous, so one event loop cannot interleave two claims.
 * That is why the offline suite cannot fail on its removal (it was tried; the test stayed green), and why the
 * reason lives here instead of in a test that cannot observe it.
 *
 * BEST-EFFORT BY CONSTRUCTION: the set is bounded, so a key is eventually forgotten and a retry old enough to have
 * fallen out will run again. That is the honest contract for a dedup window, and it is stated in the API docs
 * rather than implied — an unbounded set is a disk that fills up instead.
 */
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";

/**
 * How many keys are remembered per task. A retry storm is minutes wide and a scheduled caller's is hours; 512 keys
 * covers both without a file count anyone has to think about (the same number, for the same reason, as the claims
 * `claimSlot` keeps).
 */
const KEEP_KEYS = 512;

/** A file name that cannot collide with a path, carry a caller's bytes, or vary between two calls of one key. */
const keyName = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 32);

const keyDir = (stateRoot: string, name: string): string => join(stateRoot, "schedule", "keys", name);

/** Drop the oldest keys once the directory is over the cap. Mtime, because an opaque name carries no order. */
function pruneKeys(dir: string, names: string[]): void {
  if (names.length <= KEEP_KEYS) return;
  const byAge = names
    .map((n) => ({ n, at: statSync(join(dir, n), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => a.at - b.at);
  for (const { n } of byAge.slice(0, names.length - KEEP_KEYS)) {
    try {
      unlinkSync(join(dir, n));
    } catch (e) {
      // A key that could not be removed is a key remembered longer than asked — harmless, and not worth failing a
      // call that has already been admitted.
      log.debug(`[schedule] could not prune idempotency key ${n}: ${String(e)}`);
    }
  }
}

/**
 * Claim `key` for `name`: `true` when this call is the first to hold it, `false` when a previous call already did.
 *
 * Throws on a real IO fault (the directory is unreadable, the disk is full). The caller reports it and runs
 * NOTHING — admitting a turn whose dedup could not be recorded is how a retry becomes a second turn.
 */
export function claimIdempotencyKey(stateRoot: string, name: string, key: string): boolean {
  const dir = keyDir(stateRoot, name);
  mkdirSync(dir, { recursive: true });
  const wanted = keyName(key);
  try {
    // `wx` is the decision. Between the readdir below and here, a concurrent retry would lose the create, not the
    // race — which is the property a read-then-write check cannot have.
    const fd = openSync(join(dir, wanted), "wx");
    // Nothing is written INTO it: the name is the whole record, and an empty file cannot be read back half-written.
    closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  pruneKeys(dir, readdirSync(dir));
  return true;
}
