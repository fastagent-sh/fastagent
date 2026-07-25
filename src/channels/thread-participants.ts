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
 * - **`derived`** — whether the thread's participation was established rather than merely glimpsed —
 *   is PROCESS-LOCAL. Persisting it would make a single listing authoritative forever: a thread would
 *   be read once ever, a failed read would be a durable "do not retry", and a permission granted
 *   afterwards would need the file deleted by hand. Kept in memory, each process re-establishes each
 *   thread once, which is also what bounds how stale the answer can get.
 *
 * The listing answers from the thread's RECENT WINDOW — "who is taking part now", not "who ever
 * spoke". Humans joining later are seen live, since the channel observes every message it can see; a
 * human LEAVING is not observable at all (the platform emits nothing), so within one process a thread
 * that has gone quiet stays multi-party until a restart re-establishes it.
 *
 * Participation is keyed by `thread_id`: Feishu's `root_id` is NOT thread-stable (a thread shows
 * different `root_id`s as its reply chain moves), so it cannot identify a side conversation.
 */
import { log } from "../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

/** Cap on cached threads: dropping one costs a single list call to re-derive, so an unbounded file
 *  (and an unbounded boot-time load) would buy nothing. Oldest entries are evicted first. */
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
  /** Whether THIS process established the human set from a platform listing. Speaking unprompted
   *  requires it: observation alone can only UNDER-count the humans in a thread. */
  derived: boolean;
  /** Whether the platform definitively refused to describe this thread. Distinct from `derived` on
   *  purpose — it means "do not ask again", NOT "the human set is known". Collapsing the two would let
   *  a refusal promote an observed-only record into an authoritative one, and the agent would speak
   *  unprompted in a thread it cannot see. */
  unreadable: boolean;
}

export interface ThreadParticipants {
  /** Known participation, or undefined when nothing about the thread has been seen or read. */
  get(key: string): ThreadParticipation | undefined;
  /** Merge in what was just observed or read back. Idempotent; a failed write is a warning, never a
   *  failed delivery (the platform can re-derive it). */
  merge(key: string, seen: Partial<ThreadParticipation>): void;
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
  // Process-local: see the module header. A restart re-establishes each thread once.
  const derivedKeys = new Set<string>();
  const unreadableKeys = new Set<string>();

  return {
    get(key) {
      const record = records.get(key);
      return record === undefined
        ? undefined
        : { ...record, derived: derivedKeys.has(key), unreadable: unreadableKeys.has(key) };
    },
    merge(key, seen) {
      const previous = records.get(key);
      // A derived listing REPLACES the human set: it samples the thread's recent window, so it is the
      // answer to "who is in this conversation now" rather than "who ever spoke". An EMPTY set never
      // replaces: a listing that names nobody is an anomaly, not the news that the thread is empty,
      // and dropping the humans already seen there could admit a message it must not.
      const replacing = seen.derived === true && (seen.humans?.length ?? 0) > 0;
      const humans = new Set(replacing ? [] : (previous?.humans ?? []));
      for (const human of seen.humans ?? []) {
        if (humans.size >= MAX_HUMANS) break;
        humans.add(human);
      }
      if (seen.derived === true) derivedKeys.add(key);
      if (seen.unreadable === true) unreadableKeys.add(key);
      const next: StoredParticipation = {
        humans: [...humans],
        agentSpoke: (previous?.agentSpoke ?? false) || (seen.agentSpoke ?? false),
      };
      if (
        previous !== undefined &&
        previous.agentSpoke === next.agentSpoke &&
        previous.humans.length === next.humans.length &&
        previous.humans.every((human) => humans.has(human))
      ) {
        return; // nothing new to persist — the process-local flags above are memory-only
      }
      records.delete(key); // re-insert so insertion order stays "least recently updated first"
      records.set(key, next);
      while (records.size > MAX_THREADS) {
        const oldest = records.keys().next().value;
        if (oldest === undefined) break;
        records.delete(oldest);
        derivedKeys.delete(oldest);
        unreadableKeys.delete(oldest);
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
