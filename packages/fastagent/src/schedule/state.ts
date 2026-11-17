/**
 * Each schedule's fires, kept in the clock's store (clock.ts): the claim that DECIDES an occurrence runs, and how it
 * ended once it did. The claims are also the history `fastagent info` and `schedules.list` read.
 */
import { log } from "../log.ts";
import type { ClockStore } from "./clock.ts";

/**
 * How many fires to keep per schedule, and so how far back its history reaches: at 512 a minute cron keeps ~8.5 hours,
 * an hourly one ~3 weeks. The gate reads only the newest, which is never dropped.
 */
const KEEP_FIRES = 512;

/**
 * How a claimed occurrence ended. `skipped` is not a failure: a schedule's turns share one session, so an occurrence
 * arriving while the previous one runs is refused by it, the overlap policy every scheduler names (Kubernetes
 * `concurrencyPolicy: Forbid`, Temporal's `Skip`).
 */
export type FireOutcome = "completed" | "failed" | "skipped" | "interrupted";

/** One claimed occurrence. `outcome` absent = claimed, never settled. */
export interface Fire {
  /** The slot this fire was FOR (ISO 8601). */
  slot: string;
  /** When the claim was taken. */
  firedAt: string;
  outcome?: FireOutcome;
  /** How long its turn took, when it was timed. */
  ms?: number;
}

/**
 * Why a slot is not ours. `duplicate` is ordinary (the same delivery arrived twice, or another fire of this process has
 * it); `stale` means the schedule has moved past this instant, and the slot will never run.
 */
export type SlotClaimOutcome =
  | { taken: true }
  | { taken: false; why: "duplicate" }
  | { taken: false; why: "stale"; newest: string };

/**
 * Take a cron slot, or report that it is not ours. One commit decides it: a resident clock and a fire on demand race
 * for the same slot, and exactly one takes it. A slot before the newest claim is a stale replay, never fired.
 */
export function claimSlot(clock: ClockStore, name: string, slot: Date, firedAt: Date): Promise<SlotClaimOutcome> {
  const wanted = slot.toISOString();
  return clock.fires(name, (fires): { next?: readonly Fire[]; result: SlotClaimOutcome } => {
    const newest = fires.at(-1)?.slot;
    if (newest !== undefined && wanted < newest) return { result: { taken: false, why: "stale", newest } };
    if (newest === wanted) return { result: { taken: false, why: "duplicate" } };
    const next = [...fires, { slot: wanted, firedAt: firedAt.toISOString() }].slice(-KEEP_FIRES);
    return { next, result: { taken: true } };
  });
}

/**
 * Write back how the claimed fire ended. Housekeeping: the turn already happened, so a failure is logged and the fire
 * stays unsettled, which the next boot accounts for while it is the newest. A fire dropped from the history meanwhile
 * takes its outcome with it.
 */
export async function settleClaim(
  clock: ClockStore,
  name: string,
  slot: Date,
  outcome: FireOutcome,
  ms?: number,
): Promise<void> {
  const key = slot.toISOString();
  await clock
    .fires(name, (fires) => {
      const index = fires.findIndex((fire) => fire.slot === key);
      if (index === -1) return { result: undefined };
      const next = [...fires];
      // A duration only when one was measured: nobody timed an `interrupted` fire.
      next[index] = { ...(fires[index] as Fire), outcome, ...(ms === undefined ? {} : { ms: Math.round(ms) }) };
      return { next, result: undefined };
    })
    .catch((error: unknown) =>
      log.warn(`[schedule] ${name}: could not record the ${outcome} outcome of slot ${key}: ${String(error)}`),
    );
}

/** Every fire kept for `name`, oldest first. */
export function readFires(clock: ClockStore, name: string): Promise<readonly Fire[]> {
  return clock.stored.fires(name);
}

/** The newest fire of `name`: where catch-up resumes, and whether that fire ever reported. */
export async function latestFire(clock: ClockStore, name: string): Promise<Fire | undefined> {
  return (await clock.stored.fires(name)).at(-1);
}
