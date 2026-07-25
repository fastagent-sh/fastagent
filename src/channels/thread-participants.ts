/**
 * SHARED: who is taking part in a group thread — the input to the participant model's summon rule
 * (docs/design/participant-model.md §3): the agent speaks unprompted only where it is a participant
 * and exactly one human is. Channels supply their own place key (Feishu `chat:thread`, Slack
 * `team:channel:thread_ts`) and their own way of reading a thread's senders back; the storage
 * discipline below is identical for both and deliberately lives in one place.
 *
 * Two kinds of knowledge, deliberately stored differently:
 *
 * - **Observations** (`humans`, `agentSpoke`) are DURABLE. They accumulate from the messages this
 *   channel sees and from a platform listing, and they only ever under-count — a message observed is
 *   a fact that a restart should not forget.
 * - **`established`** — whether the human set is AUTHORITATIVE (a platform listing settled it) rather
 *   than merely what this process happened to see — is PROCESS-LOCAL. Persisting it would make a
 *   single listing authoritative forever: a thread would be read once ever, a failed read would be a
 *   durable "do not retry", and a permission granted afterwards would need the file deleted by hand.
 *   Kept in memory, each process establishes each thread once, which is also what bounds how stale
 *   the answer can get.
 *
 * The two sources cover different time: observation covers the present (every message this process can
 * see), and the listing covers the past this process never watched — which is why it reads a thread
 * from its START. They are UNIONED, never replaced, so participation only ever ACCUMULATES: a thread
 * that has held two humans keeps requiring a mention, across restarts, and `agentSpoke` never decays.
 * The asymmetry is deliberate — over-counting humans only makes the agent ask to be named, while
 * under-counting makes it speak unprompted in a crowded thread, which is the failure §3 exists to
 * prevent. Nothing is shed: the platform emits no event when someone leaves, so shedding could only
 * ever be guessed from a window that might simply have missed them. A restart resets the
 * process-local flags (`established`, `unreadable`) and nothing else — which is what makes each
 * process read a thread once, and why a permission granted later needs no file deleted by hand.
 *
 * ponytail: establishment is bounded to ONE page of a thread (50 messages). A second human whose only
 * messages fall beyond that page AND predate this process is therefore invisible to both sources, and
 * such a thread reads as two-party. It is the one direction this design otherwise avoids, and it is
 * accepted because the alternatives are worse: refusing to establish any thread longer than a page
 * would deny mention-free replies to exactly the long working threads that want them, and covering
 * both ends of a thread costs a second platform round trip that does not fit the pre-ACK budget. The
 * exposure shrinks with uptime, since observation accumulates every message the process does see.
 *
 * Participation is keyed by `thread_id`: Feishu's `root_id` is NOT thread-stable (a thread shows
 * different `root_id`s as its reply chain moves), so it cannot identify a side conversation.
 */
import { log } from "../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

/** Cap on cached threads. Dropping one costs a single list call to re-derive, so an unbounded file
 *  buys nothing — and it is not only boot-time load: a merge that carries new information rewrites the
 *  WHOLE map synchronously on the pre-ACK path, so the map's size is also the cost of every such
 *  write. What keeps that bounded is that only NEW information writes at all (a repeat sender, or any
 *  message once MAX_HUMANS is reached, returns before persisting). Oldest entries are evicted first. */
const MAX_THREADS = 5000;

/** Cap on remembered humans per thread. The rule only asks "exactly one?", so a second human is
 *  already the whole answer and anything beyond it is weight the predicate never reads. */
const MAX_HUMANS = 2;

/** What a restart keeps: observations, which only under-count. */
interface StoredParticipation {
  humans: string[];
  agentSpoke: boolean;
}

interface ThreadParticipation extends StoredParticipation {
  /** Whether the human set is authoritative — a platform listing settled it in THIS process. Speaking
   *  unprompted requires it, because observation alone can only UNDER-count the humans in a thread. */
  established: boolean;
  /** Whether the platform definitively refused to describe this thread — "do not ask again", which is
   *  NOT the same claim as `established`. Collapsing the two would let a refusal promote an
   *  observed-only record into an authoritative one, and the agent would speak unprompted in a thread
   *  it cannot see. */
  unreadable: boolean;
}

export interface ThreadParticipants {
  /** Known participation, or undefined when nothing about the thread has been seen or read. */
  get(key: string): ThreadParticipation | undefined;
  /**
   * Merge in what was just observed or read back. Idempotent; a failed write is a warning, never a
   * failed delivery (the platform can re-derive it).
   *
   * The parameter only admits values the store can honour: participation accumulates, so a flag can
   * be set but never cleared, and `humans` unions. Passing `false` to clear one would compile and do
   * nothing, so the type refuses it — "never shed" is an invariant, not a convention.
   */
  merge(key: string, seen: { humans?: string[]; agentSpoke?: true; established?: true; unreadable?: true }): void;
}

function isRecord(value: unknown): value is StoredParticipation {
  const record = value as StoredParticipation;
  return (
    Array.isArray(record?.humans) &&
    record.humans.every((human) => typeof human === "string") &&
    typeof record.agentSpoke === "boolean"
  );
}

export function createThreadParticipants(path: string, label: string): ThreadParticipants {
  const raw = loadStateFile(path);
  const records = new Map<string, StoredParticipation>();
  if (raw !== undefined) {
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(isRecord)) {
      for (const [key, record] of Object.entries(raw as Record<string, StoredParticipation>)) {
        records.set(key, { humans: record.humans, agentSpoke: record.agentSpoke });
      }
    } else {
      log.warn(`${label} unexpected shape in ${path} — starting with no thread participation`);
    }
  }
  // Process-local: see the module header. A restart re-establishes each thread once. Capped on its
  // own, because an unreadable thread stores no observation and so is never reached by the eviction
  // that bounds `records` — without this, a workspace full of threads the app cannot read would leak
  // one entry per thread for the life of the process.
  const flags = new Map<string, { established: boolean; unreadable: boolean }>();
  const flag = (key: string, next: { established?: boolean; unreadable?: boolean }): void => {
    const previous = flags.get(key);
    flags.delete(key); // re-insert so insertion order stays "least recently flagged first"
    flags.set(key, {
      established: (previous?.established ?? false) || (next.established ?? false),
      unreadable: (previous?.unreadable ?? false) || (next.unreadable ?? false),
    });
    while (flags.size > MAX_THREADS) {
      const oldest = flags.keys().next().value;
      if (oldest === undefined) break;
      flags.delete(oldest);
    }
  };

  return {
    get(key) {
      const established = flags.get(key)?.established ?? false;
      const unreadable = flags.get(key)?.unreadable ?? false;
      const record = records.get(key);
      // A thread can be flagged without a stored row: an unreadable one contributes no observation, so
      // nothing is persisted for it, yet the channel must still see the flag and stop re-reading.
      if (record === undefined) {
        return established || unreadable ? { humans: [], agentSpoke: false, established, unreadable } : undefined;
      }
      return { ...record, established, unreadable };
    },
    merge(key, seen) {
      const previous = records.get(key);
      // UNION, never replace — see the module header: a listing and this channel's observations cover
      // different stretches of a thread, so either erasing the other could drop a human and let the
      // agent speak unprompted in a crowded thread.
      const humans = new Set(previous?.humans ?? []);
      for (const human of seen.humans ?? []) {
        if (humans.size >= MAX_HUMANS) break;
        humans.add(human);
      }
      if (seen.established === true || seen.unreadable === true) {
        flag(key, { established: seen.established, unreadable: seen.unreadable });
      }
      const next: StoredParticipation = {
        humans: [...humans],
        agentSpoke: (previous?.agentSpoke ?? false) || (seen.agentSpoke ?? false),
      };
      // `humans` starts from `previous` and only grows, so equal size IS set equality here — a
      // containment check would read as if the set could be replaced, which the union invariant above
      // forbids.
      const unchanged =
        previous !== undefined &&
        previous.agentSpoke === next.agentSpoke &&
        previous.humans.length === next.humans.length;
      // The process-local flags above are already recorded; a merge that carries no OBSERVATION has
      // nothing to persist. Writing one would store an empty row — indistinguishable from "seen,
      // nothing known" on reload — and let unreadable threads evict real participation under the cap.
      if (unchanged || (previous === undefined && next.humans.length === 0 && !next.agentSpoke)) return;
      records.delete(key); // re-insert so insertion order stays "least recently updated first"
      records.set(key, next);
      while (records.size > MAX_THREADS) {
        const oldest = records.keys().next().value;
        if (oldest === undefined) break;
        records.delete(oldest);
        flags.delete(oldest);
      }
      try {
        saveStateFile(path, Object.fromEntries(records));
      } catch (error) {
        // Cache only: memory stays correct for this process, and the whole map is rewritten on the
        // next successful merge — so a failed write costs durability only until then (or until a
        // restart, where the platform re-derives it).
        log.warn(`${label} could not persist thread participation ${path}: ${String(error)}`);
      }
    },
  };
}
