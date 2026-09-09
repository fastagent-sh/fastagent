/**
 * Durable turn intent: the at-least-once half of durable execution. Exactly-once execution needs a different
 * backend and is out of scope (docs/design/core.md §10).
 *
 * ponytail: at-least-once with a per-turn EXECUTION ceiling ({@link MAX_TURN_ATTEMPTS}). A poison turn that
 * deterministically crashes the process would otherwise replay forever under a container restart policy; a real
 * exactly-once story needs the different backend above.
 */
import { log } from "../../log.ts";
import type { ContextBuffer } from "./context-buffer.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

/** How many times a turn may START without finishing before it is dropped rather than run again. */
const MAX_TURN_ATTEMPTS = 3;

/** What every persisted turn record carries regardless of channel. */
export interface TurnRecordBase {
  id: string;
  session: string;
  attempts: number;
}

export interface TurnStore<T extends TurnRecordBase> {
  /** Persist an accepted turn before the ACK. */
  add(rec: T): void;
  remove(id: string): void;
  /**
   * Every persisted turn a crash left behind, in ARRIVAL order (the channel's `order`), to re-enqueue on the next
   * start.
   */
  recover(): T[];
  /** Called when a turn is about to RUN (dequeued). */
  startAttempt(id: string): "run" | "exceeded" | "defer";
}

export interface TurnStoreOptions<T extends TurnRecordBase> {
  /** Log prefix naming the consumer (e.g. "[telegram]") — the store itself is channel-neutral. */
  label: string;
  /**
   * Shape validation at the IO boundary: valid JSON of the WRONG SHAPE must degrade like a corrupt file (warn +
   * empty), not flow in as trusted data.
   */
  isRecord: (t: unknown) => t is T;
  /**
   * Arrival order for {@link TurnStore.recover} — the channel knows what its ids/fields encode (telegram: numeric
   * update_id; lark: an explicit per-record seq).
   */
  order: (a: T, b: T) => number;
}

/** End an ANSWERED turn: drop its durable intent, then commit the discussion it folded in. */
export function commitAnsweredTurn<T extends TurnRecordBase, E>(
  store: TurnStore<T>,
  buffer: ContextBuffer<E>,
  turn: { id: string; bufferKey: string; consumed: E[] },
): void {
  store.remove(turn.id);
  buffer.commit(turn.bufferKey, turn.consumed);
}

export function createTurnStore<T extends TurnRecordBase>(path: string, opts: TurnStoreOptions<T>): TurnStore<T> {
  const { label, isRecord, order } = opts;
  const load = (): Map<string, T> => {
    const raw = loadStateFile(path);
    if (raw === undefined) return new Map();
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(isRecord)) {
      return new Map(Object.entries(raw as Record<string, T>));
    }
    log.warn(`${label} unexpected shape in ${path} — starting with no pending turns`);
    return new Map();
  };
  const turns = load();
  const persist = (): void => saveStateFile(path, Object.fromEntries(turns));
  // Post-ACK writes (remove, startAttempt) must not abort a turn: log a failed write, never throw.
  const persistBestEffort = (what: string): void => {
    try {
      persist();
    } catch (e) {
      log.error(`${label} turn-store ${what} write failed post-ACK: ${String(e)}`);
    }
  };

  return {
    add(rec) {
      // Idempotent on re-add: a redelivery (pre-ACK crash → never-ACKed event replayed) re-submits an id already in
      // the store.
      if (turns.has(rec.id)) return;
      turns.set(rec.id, rec);
      try {
        persist(); // pre-ACK: the transport maps this throw to HTTP/WS 500, so the platform redelivers
      } catch (e) {
        // Roll the memory back so it matches disk (mirrors context-buffer.push): otherwise the phantom entry makes
        // the redelivery's `add` short-circuit on `turns.has`.
        turns.delete(rec.id);
        throw e;
      }
    },
    remove(id) {
      if (turns.delete(id)) persistBestEffort("remove (a restart may replay an answered turn)");
    },
    recover() {
      // The channel's arrival order, applied explicitly rather than leaning on JS object-key enumeration happening to
      // survive the load's JSON round-trip.
      return [...turns.values()].sort(order);
    },
    startAttempt(id) {
      const rec = turns.get(id);
      if (!rec) return "run"; // no record — run untracked (a redelivery double-run whose first run removed it)
      const attempts = rec.attempts + 1;
      if (attempts > MAX_TURN_ATTEMPTS) {
        // State the fact, not a cause the counter can't prove: a turn killed mid-run every time bumps this whether IT
        // poisoned the process or a deploy/OOM took it down each time.
        log.error(
          `${label} dropping turn ${id} after starting ${rec.attempts} time(s) without finishing ` +
            `(session=${rec.session}) — it may be crashing the process, or was killed mid-run each time; notifying the asker`,
        );
        turns.delete(id);
        persistBestEffort("drop");
        return "exceeded";
      }
      turns.set(id, { ...rec, attempts });
      try {
        persist();
      } catch (e) {
        // The bump MUST be durable, unlike remove/drop: if it isn't, a restart's recover() reads the old count and
        // RE-RUNS this turn.
        turns.set(id, rec);
        log.error(
          `${label} cannot persist turn ${id}'s attempt count — deferring it to the next start rather ` +
            `than run it untracked (session=${rec.session}): ${String(e)}`,
        );
        return "defer";
      }
      return "run";
    },
  };
}
