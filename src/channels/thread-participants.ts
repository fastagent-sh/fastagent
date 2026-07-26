/**
 * SHARED: who the agent has HEARD in a group thread — the input to the participant model's summon
 * rule (docs/design/participant-model.md §3): it speaks unprompted only where it takes part and has
 * not heard a second human. Channels supply their own place key (Feishu `chat:thread`, Slack
 * `team:channel:thread_ts`); the storage discipline is identical for both and lives here.
 *
 * **The rule is defined over what the agent observed, not over the thread's true membership.** That is
 * the load-bearing decision. No platform transmits "who is taking part", and none emits an event when
 * someone stops; the only way to claim ground truth is to read a thread back from the platform on the
 * acceptance path — a remote, paginated, deadline-bound call that must finish inside the event ACK
 * window. That was tried (git history on this file): it bought a claim that its own page cap made
 * incomplete anyway, and it dragged in a failure taxonomy, an ACK budget, request aborts, a
 * completeness flag and its refusal-flag sibling, and a duplicate-delivery join — which is where
 * nearly every defect lived. Observation makes the weaker claim the rule actually needs, and it is
 * free: the channel already sees these messages.
 *
 * What the weaker claim costs, stated plainly: a thread the agent joined before this deployment — or
 * before a lost state file — reads as unheard, so it takes one mention to re-enter. That is the same
 * bootstrap every thread starts with, it self-heals in one message, and it is visible to the user,
 * unlike the failure this replaced (silently mention-only, forever, with no signal).
 *
 * Observations only ever ACCUMULATE. Nothing is shed, because the absence of a signal is not evidence
 * that someone left, and because the error directions are not symmetric: over-counting humans makes
 * the agent ask to be named, under-counting makes it speak into a crowd.
 *
 * Keyed by `thread_id`, never a reply-chain root: Feishu's `root_id` moves with the chain, so it
 * cannot identify a side conversation at all.
 */
import { log } from "../log.ts";
import { loadStateFile, saveStateFile } from "./state.ts";

/** Cap on remembered threads. Losing one costs a mention to re-enter that thread, so an unbounded file
 *  buys little — and a merge that carries new information rewrites the whole map synchronously, so the
 *  map's size is the cost of every such write. What keeps that bounded is that only NEW information
 *  writes at all (a repeat speaker, or any message once MAX_HUMANS is reached, returns before
 *  persisting).
 *
 *  Eviction prefers BYSTANDER threads — ones the agent has only listened to. They are written on the
 *  same path and vastly outnumber the rest (every thread in every visible channel), yet losing one
 *  costs nothing: the summon rule refuses a thread the agent has not spoken in anyway, so the record
 *  would have to be rebuilt by the mention that admits it. Evicting purely by age would let this
 *  traffic push out the threads the agent is actively serving, silently reverting them to
 *  mention-only. This is also what makes it safe for a channel to record threads no rule reads
 *  (Feishu's p2p and custom-route records, kept so a record is never half-written). */
const MAX_THREADS = 5000;

/** Cap on remembered humans per thread. The rule only asks "have I heard a second one?", so two is
 *  already the whole answer and anything beyond it is weight nothing reads. */
const MAX_HUMANS = 2;

interface ThreadParticipation {
  /** Distinct humans heard in this thread (capped, see {@link MAX_HUMANS}). */
  humans: string[];
  /** Whether the agent has answered here — what makes it a participant rather than a bystander. */
  agentSpoke: boolean;
}

export interface ThreadParticipants {
  /** What has been heard in this thread, or undefined when nothing has. */
  get(key: string): ThreadParticipation | undefined;
  /**
   * Merge in what was just heard. Idempotent; a failed write is a warning, never a failed delivery.
   *
   * The parameter only admits values the store can honour: observations accumulate, so `agentSpoke`
   * can be set but never cleared and `humans` unions. Passing `false` would compile and do nothing,
   * so the type refuses it — "never shed" is an invariant, not a convention.
   */
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
    get(key) {
      const record = records.get(key);
      // Deep enough to cover the only mutable field: `merge`'s signature refuses a shrinking write so
      // that "never shed" is an invariant rather than a convention, and handing out the live array
      // would put it back to a convention on the read path.
      return record === undefined ? undefined : { humans: [...record.humans], agentSpoke: record.agentSpoke };
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
      // Re-insert so insertion order is "least recently TOUCHED first" — including when nothing
      // changed. A thread in its steady state (the agent answers, the same person keeps talking) stops
      // carrying new information and would otherwise never refresh its position again, leaving the
      // thread being served right now at the head of the eviction order. Touching memory is free; the
      // refreshed order reaches disk with the next write that has something to say.
      records.delete(key);
      records.set(key, next);
      if (unchanged) return;
      while (records.size > MAX_THREADS) {
        // Oldest bystander first; only when every record is a thread the agent takes part in does age
        // alone decide.
        let evict: string | undefined;
        for (const [candidate, record] of records) {
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
        // Cache only: memory stays correct for this process, and the whole map is rewritten on the
        // next successful merge — so a failed write costs durability only until then, and a thread
        // whose record is lost simply needs a mention to re-enter.
        log.warn(`${label} could not persist thread participation ${path}: ${String(error)}`);
      }
    },
  };
}
