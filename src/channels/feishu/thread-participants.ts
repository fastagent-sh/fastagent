/**
 * Who is taking part in a group thread — the input to the participant model's summon rule
 * (docs/design/participant-model.md §3): the agent speaks unprompted only where it is a participant
 * and exactly one human is.
 *
 * This is a CACHE, refined two ways: every observed message merges its sender in (authoritative going
 * forward, since the channel hears everything in a thread it can see), and a thread the process has
 * never seen is re-derived from the platform (`listThreadSenders`). Losing the file therefore costs
 * one lookup per thread, never the behavior — the same discipline the managed-root cache used, and
 * the reason participation is keyed by `thread_id`: Feishu's `root_id` is NOT thread-stable (a thread
 * shows different `root_id`s as its reply chain moves), so it cannot identify a side conversation.
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../state.ts";

/** Cap on cached threads: dropping one costs a single list call to re-derive, so an unbounded file
 *  (and an unbounded boot-time load) would buy nothing. Oldest entries are evicted first. */
const MAX_THREADS = 5000;

/** Cap on remembered humans per thread. The rule only asks "exactly one?", so two is already an
 *  answer; a few more keep the record readable in state dumps without growing with the thread. */
const MAX_HUMANS = 8;

interface FeishuThreadParticipation {
  /** Distinct human open_ids seen in this thread (capped, see {@link MAX_HUMANS}). */
  humans: string[];
  /** Whether THIS agent has spoken in the thread. */
  agentSpoke: boolean;
  /**
   * Whether the record covers the thread from its start, rather than only the messages this process
   * happened to observe. True once the platform listing succeeded, or once the agent itself answered
   * in the thread (its own participation is the half that decides the rule). A merely observed
   * record stays `false`, so a failed derivation is retried instead of being mistaken for an answer.
   */
  derived: boolean;
}

interface StoredParticipation extends FeishuThreadParticipation {
  updatedAt: number;
}

export interface FeishuThreadParticipants {
  /** Known participation, or undefined when this process has never seen the thread. */
  get(chatId: string, threadId: string): FeishuThreadParticipation | undefined;
  /** Merge in what was just observed or read back. Idempotent; a failed write is a warning, never a
   *  failed delivery (the platform can re-derive it). */
  merge(chatId: string, threadId: string, seen: Partial<FeishuThreadParticipation>): void;
}

function isRecord(value: unknown): value is StoredParticipation {
  const record = value as StoredParticipation;
  return (
    Array.isArray(record?.humans) &&
    record.humans.every((human) => typeof human === "string") &&
    typeof record.agentSpoke === "boolean" &&
    typeof record.derived === "boolean" &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt)
  );
}

export function createFeishuThreadParticipants(
  path: string,
  label: string,
  now: () => number = Date.now,
): FeishuThreadParticipants {
  const raw = loadStateFile(path);
  const records = new Map<string, StoredParticipation>();
  if (raw !== undefined) {
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(isRecord)) {
      for (const [key, record] of Object.entries(raw as Record<string, StoredParticipation>)) {
        records.set(key, record);
      }
    } else {
      log.warn(`${label} unexpected shape in ${path} — starting with no thread participation`);
    }
  }

  const keyOf = (chatId: string, threadId: string): string => `${chatId}:${threadId}`;

  return {
    get(chatId, threadId) {
      const record = records.get(keyOf(chatId, threadId));
      return record === undefined
        ? undefined
        : { humans: record.humans, agentSpoke: record.agentSpoke, derived: record.derived };
    },
    merge(chatId, threadId, seen) {
      const key = keyOf(chatId, threadId);
      const previous = records.get(key);
      const humans = new Set(previous?.humans ?? []);
      for (const human of seen.humans ?? []) {
        if (humans.size >= MAX_HUMANS) break;
        humans.add(human);
      }
      const next: StoredParticipation = {
        humans: [...humans],
        agentSpoke: (previous?.agentSpoke ?? false) || (seen.agentSpoke ?? false),
        // The agent's own reply settles the half of the rule that matters; a platform listing settles
        // both. Either way the record no longer needs deriving.
        derived: (previous?.derived ?? false) || (seen.derived ?? false) || (seen.agentSpoke ?? false),
        updatedAt: now(),
      };
      if (
        previous !== undefined &&
        previous.agentSpoke === next.agentSpoke &&
        previous.derived === next.derived &&
        previous.humans.length === next.humans.length
      ) {
        return; // nothing new — skip the write entirely
      }
      records.delete(key); // re-insert so insertion order stays "least recently updated first"
      records.set(key, next);
      while (records.size > MAX_THREADS) {
        const oldest = records.keys().next().value;
        if (oldest === undefined) break;
        records.delete(oldest);
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
