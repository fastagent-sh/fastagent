/**
 * SHARED: who the agent has HEARD in a group thread — the sole input to the participant model's summon rule
 * (docs/design/participant-model.md §3). The key MUST be the string the SESSION uses: a record here is a claim about
 * that session's memory, so the two cannot be keyed independently.
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

const MAX_THREADS = 1000;

/** Cap on remembered humans per thread. */
const MAX_HUMANS = 2;

interface ThreadParticipation {
  /** Distinct humans heard in this thread (capped, see {@link MAX_HUMANS}). */
  humans: string[];
  /** Whether the agent has answered here — what makes it a participant rather than a bystander. */
  agentSpoke: boolean;
}

export interface ThreadParticipants {
  /**
   * The participant model's summon rule (docs/design/participant-model.md §3): does a bare message in this thread
   * address the agent?
   */
  admitsBareMessage(key: string): boolean;
  /** Has the agent answered into this thread before. */
  agentSpokeIn(key: string): boolean;
  /** `agentSpoke?: true` and not `boolean`: observations only ever accumulate, so there is no "un-speak" to pass. */
  merge(key: string, heard: { humans?: string[]; agentSpoke?: true }): void;
}

function isStoredParticipation(value: unknown): value is ThreadParticipation {
  const record = value as ThreadParticipation;
  return (
    Array.isArray(record?.humans) &&
    record.humans.every((human) => typeof human === "string") &&
    typeof record.agentSpoke === "boolean"
  );
}

export function createThreadParticipants(path: string, label: string): ThreadParticipants {
  const raw = loadStateFile(path);
  const records = new Map<string, ThreadParticipation>();
  if (raw !== undefined) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.values(raw).every(isStoredParticipation)
    ) {
      for (const [key, record] of Object.entries(raw as Record<string, ThreadParticipation>)) {
        records.set(key, { humans: record.humans, agentSpoke: record.agentSpoke });
      }
    } else {
      log.warn(`${label} unexpected shape in ${path} — starting with no thread participation`);
    }
  }

  return {
    admitsBareMessage(key) {
      const heard = records.get(key);
      return heard?.agentSpoke === true && heard.humans.length <= 1;
    },
    agentSpokeIn(key) {
      return records.get(key)?.agentSpoke === true;
    },
    merge(key, heard) {
      const previous = records.get(key);
      const humans = new Set(previous?.humans ?? []);
      for (const human of heard.humans ?? []) {
        if (humans.size >= MAX_HUMANS) break;
        humans.add(human);
      }
      const next: ThreadParticipation = {
        humans: [...humans],
        agentSpoke: (previous?.agentSpoke ?? false) || (heard.agentSpoke ?? false),
      };
      // `humans` starts from `previous` and only grows, so equal size IS set equality here.
      const unchanged =
        previous !== undefined &&
        previous.agentSpoke === next.agentSpoke &&
        previous.humans.length === next.humans.length;
      // Re-insert so insertion order is "least recently TOUCHED first" — including when nothing changed.
      records.delete(key);
      records.set(key, next);
      if (unchanged) return;
      while (records.size > MAX_THREADS) {
        // Oldest bystander first; only when every record is a thread the agent takes part in does age alone decide.
        let evict: string | undefined;
        for (const [candidate, record] of records) {
          if (candidate === key) continue;
          if (!record.agentSpoke) {
            evict = candidate;
            break;
          }
          evict ??= candidate;
        }
        if (evict === undefined) break;
        records.delete(evict);
      }
      try {
        saveStateFile(path, Object.fromEntries(records));
      } catch (error) {
        // Cache only: memory stays correct for this process, and the whole map is rewritten on the next successful
        // merge.
        log.warn(`${label} could not persist thread participation ${path}: ${String(error)}`);
      }
    },
  };
}
