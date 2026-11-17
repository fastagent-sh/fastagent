/**
 * Where an instance's clock keeps what it decided: each schedule's fires, the pending wake-ups, and the session each
 * schedule talks in. It lives in the instance's storage beside its sessions (harnesses/pi-durable/clock.ts), so a
 * deployment keeps it wherever it keeps them, and one process holds it as it holds them.
 *
 * Each call is one atomic commit: `change` reads the state as stored, and what it returns as the state's new value is
 * stored with its result, or nothing is.
 */
import type { Fire } from "./state.ts";
import type { Wakeup } from "./wakeups.ts";

export type Change<S, T> = (current: S) => { next?: S; result: T };

export interface ClockStore {
  /** One schedule's fires, oldest first. */
  fires<T>(name: string, change: Change<readonly Fire[], T>): Promise<T>;
  /** The pending wake-ups, in the order they were set. */
  wakeups<T>(change: Change<readonly Wakeup[], T>): Promise<T>;
  /** The session each schedule continues, by its name. */
  sessions<T>(change: Change<Readonly<Record<string, string>>, T>): Promise<T>;
}

/** Read only: a change that keeps the state. */
export const reading =
  <S, T>(read: (current: S) => T): Change<S, T> =>
  (current) => ({ result: read(current) });
