/**
 * Durable, per-session-serialized turn execution with crash recovery and redelivery dedup — the
 * reliability spine under a webhook channel. Nothing here is Telegram-specific (records are opaque
 * beyond {@link TurnRecord}); it lives in the telegram folder because that is its only consumer today.
 *
 * The invariants (they live HERE, not in the caller):
 *  1. ACCEPT is durable-or-nothing: a record is staged and persisted BEFORE anything is scheduled; a
 *     failed pre-ACK write rolls the stage back and rethrows (the webhook 500s, the platform
 *     redelivers) — nothing half-scheduled can run twice.
 *  2. One turn at a time per session (FIFO chains); different sessions run concurrently.
 *  3. Two-state WAL: `queued` → never reached execution, safe to replay after a crash; `started` → may
 *     already have produced output, so recovery DROPS it loudly (a duplicate answer is worse than a
 *     visible loss). The runner calls {@link TurnStore.started} at the point output becomes possible.
 *  4. Every id recovery takes over — replayed AND dropped — is tombstoned (bounded, persisted): if the
 *     crash predated the webhook 200, the platform redelivers the update, and running it again would
 *     answer twice. Callers gate inbound updates on {@link TurnStore.suppressed}.
 *  5. Post-ACK writes never throw (no request to fail into; an uncaught throw in a chained task would
 *     be an unhandled rejection) — they log. The stale-but-atomic WAL stays diagnosable: at worst a
 *     completed turn is still `started` on disk, and the next restart drops + tombstones it (no
 *     redelivery is coming — its 200 was long delivered).
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

/** What the store needs of a record; the caller's type carries everything else the turn needs. */
export interface TurnRecord {
  /** The update's id — the turn's identity in logs, on disk, and for redelivery dedup. */
  id: string;
  /** Serialization key: one turn at a time per session. */
  session: string;
  state: "queued" | "started";
}

export interface TurnStore<T extends TurnRecord> {
  /** Stage + persist (durable-or-nothing, see invariant 1) + schedule onto the session's chain. */
  accept(rec: T): void;
  /** Whether recovery already took this id over — ACK and skip the redelivery instead of re-running. */
  suppressed(id: string): boolean;
  /** The runner MUST call this when the turn irreversibly reaches execution (output becomes possible):
   *  it flips the WAL record to `started`, which is what tells a future recovery not to replay it. */
  started(id: string): void;
  /** Merge caller-domain fields into the held record and persist (post-ACK, logged-not-thrown) — e.g.
   *  a preview message id attached after acceptance, so a replay can reuse it. The STORE owns the
   *  record: mutations go through here, never by writing the caller's reference and hoping the store
   *  shares it. */
  update(id: string, patch: Partial<Omit<T, keyof TurnRecord>>): void;
}

/** Bounded by turn count, not time: the platform's redelivery retries span minutes–hours of backoff,
 *  far fewer than 50 turns in any deployment this store targets — an evicted id being redelivered is
 *  an extreme edge where a rare duplicate beats unbounded growth. */
const TOMBSTONES_MAX = 50;

export function createTurnStore<T extends TurnRecord>(opts: {
  /** The WAL file (`{ pending, tombstones }`), atomic via state.ts. */
  path: string;
  /** Log prefix naming the consumer (e.g. "[telegram]") — the store itself is channel-neutral. */
  label: string;
  /** Shape validation at the IO boundary — wrong-shaped JSON degrades to empty, never flows in. */
  isRecord: (r: unknown) => r is T;
  /** Executes ONE turn. The store wraps it: dequeue in FIFO order, remove + persist when it settles.
   *  The runner owns the `started` transition (see {@link TurnStore.started}, via the passed handle)
   *  and its own error surface; a rejection that escapes anyway is caught and logged by the store
   *  (never a silent unhandled rejection), but the runner's own catch is where diagnosis belongs. */
  run: (rec: T, store: TurnStore<T>) => Promise<void>;
  /** Fired synchronously when a record is scheduled BEHIND an active turn (accept and recovery alike)
   *  — the caller's hook for queue feedback to the user. */
  onQueuedBehind?: (rec: T, store: TurnStore<T>) => void;
}): TurnStore<T> {
  const { path, label, isRecord, run, onQueuedBehind } = opts;

  const pending = new Map<string, T>();
  const tombstones = new Set<string>();
  const addTombstone = (id: string): void => {
    tombstones.add(id);
    for (const old of tombstones) {
      if (tombstones.size <= TOMBSTONES_MAX) break;
      tombstones.delete(old);
    }
  };
  const persist = (): void => saveStateFile(path, { pending: [...pending.values()], tombstones: [...tombstones] });
  const persistPostAck = (): void => {
    try {
      persist();
    } catch (e) {
      log.error(`${label} WAL write failed post-ACK (state stale until the next write): ${String(e)}`);
    }
  };

  // Per-session serial chains: a second turn for the same session waits its turn (FIFO) instead of
  // colliding on the engine lease and being dropped as "busy". The chain itself is in-memory; the WAL
  // is what survives a restart.
  const chains = new Map<string, Promise<void>>();
  const schedule = (rec: T): void => {
    if (chains.has(rec.session)) onQueuedBehind?.(rec, self);
    const prev = chains.get(rec.session) ?? Promise.resolve();
    const task = async (): Promise<void> => {
      try {
        await run(rec, self);
      } catch (e) {
        // The runner is expected to own its error surface, but a rejection that escapes it must not
        // become a silent unhandled rejection off the `void next.finally` branch — log it here.
        log.error(`${label} turn ${rec.id} runner rejected (own your error surface in run()): ${String(e)}`);
      } finally {
        pending.delete(rec.id);
        persistPostAck();
      }
    };
    const next = prev.then(task, task); // run after this session's previous turn, in arrival order
    chains.set(rec.session, next);
    void next.finally(() => {
      if (chains.get(rec.session) === next) chains.delete(rec.session); // drop the entry when drained
    });
  };

  const loadWal = (): { pending: T[]; tombstones: string[] } => {
    const raw = loadStateFile(path);
    if (raw !== undefined) {
      const q = raw as { pending?: unknown; tombstones?: unknown };
      if (
        typeof raw === "object" &&
        raw !== null &&
        Array.isArray(q.pending) &&
        q.pending.every(isRecord) &&
        Array.isArray(q.tombstones) &&
        q.tombstones.every((d) => typeof d === "string")
      ) {
        return q as { pending: T[]; tombstones: string[] };
      }
      log.warn(`${label} unexpected shape in ${path} — starting with an empty queue`);
    }
    return { pending: [], tombstones: [] };
  };

  const self: TurnStore<T> = {
    accept(rec) {
      pending.set(rec.id, rec);
      try {
        persist();
      } catch (e) {
        pending.delete(rec.id);
        throw e;
      }
      schedule(rec);
    },
    suppressed: (id) => tombstones.has(id),
    started(id) {
      const rec = pending.get(id);
      if (!rec) {
        log.error(`${label} started() for unknown turn ${id} — a lifecycle bug, not a user error`);
        return;
      }
      rec.state = "started";
      persistPostAck();
    },
    update(id, patch) {
      const rec = pending.get(id);
      if (!rec) return; // the turn already completed — nothing to persist the patch onto
      Object.assign(rec, patch);
      persistPostAck();
    },
  };

  // Recover the WAL a previous process left behind (construction-time, before any new update arrives).
  // EVERY recovered id is tombstoned first (invariant 4). Recovery persists ONCE after the loop — a
  // per-record persist could fail mid-loop and leave the already-replayed prefix still `queued` in the
  // WAL, to be replayed AGAIN on the next boot.
  const recovered = loadWal();
  for (const id of recovered.tombstones) tombstones.add(id);
  for (const rec of recovered.pending) {
    addTombstone(rec.id);
    if (rec.state === "started") {
      log.error(
        `${label} dropping turn ${rec.id} (session=${rec.session}): it was mid-flight when the previous ` +
          "process died and may have already answered — replaying would risk a duplicate reply. Ask again.",
      );
      continue;
    }
    log.info(`${label} recovering queued turn ${rec.id} (session=${rec.session}) from a previous process`);
    pending.set(rec.id, rec);
    schedule(rec);
  }
  persist(); // rewrite the WAL now: recovered records must not survive as pending (throws = boot fails loudly)

  return self;
}
