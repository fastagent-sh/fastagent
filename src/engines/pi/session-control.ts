/**
 * The pi implementation of the session control plane. `createPiSessionControl` returns the neutral
 * `SessionControl` plus the {@link SessionObserver} to plug into the invoke pipeline
 * (`createPiAgent({ observer })`).
 *
 * It holds no durable state of its own: live truth comes from the event stream (plus the
 * {@link RunControls} a `run_started` carries), durable truth from {@link PiSessionRecordStore} —
 * which is also what performs every write, so how a record takes a property is not knowledge this
 * file has. What it owns is the vocabulary: capability gating, the lease, error codes, and the
 * events its own writes emit.
 *
 * Writes take the same lease as runs. Without boundary wiring they reject before acceptance with
 * `unsupported_capability` — a client gating on `capabilities()` never sends them.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type SessionEntry as PiSessionEntry,
  findCutPoint,
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { type Models, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { type Json, SESSION_BUSY_CODE } from "../../agent.ts";
import {
  type AgentCommand,
  BOUNDARY_COMMAND_FAILED_CODE,
  INVALID_COMMAND_CODE,
  isAddressableSession,
  NO_ACTIVE_RUN_CODE,
  NOTHING_TO_COMPACT_CODE,
  NO_SUCH_SESSION_CODE,
  PARTIAL_UPDATE_CODE,
  UPDATE_FIELDS,
  RUN_COMMAND_FAILED_CODE,
  type RetryScheduledEvent,
  type SessionCapabilities,
  type SessionControl,
  type SessionEntries,
  type SessionEntry,
  type SessionEvent,
  type SessionResult,
  type Session,
  type SessionAction,
  type SessionState,
  type SessionUpdate,
  type SessionUpdateField,
  UNSUPPORTED_CAPABILITY_CODE,
} from "../../session.ts";
import { listModels } from "./config.ts";
import { forkProvenance, isNavigable, publishedLeaf } from "./session-markers.ts";
import type { RunControls, SessionObserver, Lease } from "./turn-kit.ts";
import type { AnyModel } from "./models.ts";
import type { PiAgentSessionFactory } from "./invoke-session.ts";
import { THINKING_LEVELS, activePath, resolveSessionSettings } from "./session-settings.ts";
import { log } from "../../log.ts";
import type { PiSessionRecordStore } from "./session-store.ts";

/** Admission uses coding-agent's cut point and context rules, including a split-turn prefix.
 *  Its prepareCompaction is private; agent-core's namesake uses a different journal format. */
function hasCompactableHistory(path: PiSessionEntry[], keepRecentTokens: number): boolean {
  if (path.at(-1)?.type === "compaction") return false;
  const previous = getLatestCompactionEntry(path);
  let start = 0;
  if (previous) {
    const kept = path.findIndex((entry) => entry.id === previous.firstKeptEntryId);
    start = kept >= 0 ? kept : path.indexOf(previous) + 1;
  }
  const { firstKeptEntryIndex } = findCutPoint(path, start, path.length, keepRecentTokens);
  return path
    .slice(start, firstKeptEntryIndex)
    .some((entry) => entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0);
}

// ── Entry normalization (durable plane) ──────────────────────────────────────

/** Concatenated plain text of a message's content blocks (the L0 rendering payload). A custom
 *  AgentMessage role may carry no `content` at all — that reads as empty, not a crash. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * pi `PiSessionEntry` → neutral {@link SessionEntry}. Message entries map onto the guaranteed
 * kind vocabulary (user/assistant/tool) with a minimal render payload; every other engine record
 * keeps its pi type as an open-set kind with an EMPTY payload — present so `parentId` chains and
 * cursors stay intact, skippable by contract, and no pi message class leaks through the adapter.
 */
function toSessionEntry(entry: PiSessionEntry, parentId?: string): SessionEntry {
  const base = {
    id: entry.id,
    parentId,
    timestamp: Date.parse(entry.timestamp),
  };
  if (entry.type === "message") {
    const m = entry.message;
    if (m.role === "user") return { ...base, kind: "user", data: { text: textOf(m.content) } };
    if (m.role === "assistant") {
      const toolCalls = (m.content as Array<{ type: string; id?: string; name?: string }>)
        .filter((b) => b.type === "toolCall")
        .map((b) => ({ id: b.id ?? "", name: b.name ?? "" }));
      const data: Json = { text: textOf(m.content) };
      if (toolCalls.length > 0) (data as { toolCalls?: Json }).toolCalls = toolCalls;
      return { ...base, kind: "assistant", data };
    }
    if (m.role === "toolResult") {
      return {
        ...base,
        kind: "tool",
        data: {
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          isError: m.isError ?? false,
          text: textOf(m.content),
        },
      };
    }
    // A custom AgentMessage role (channel/extension-defined): open-set kind, skippable.
    return { ...base, kind: `message:${(m as { role: string }).role}`, data: {} };
  }
  return { ...base, kind: entry.type, data: {} };
}

// ── Live fan-out (events plane) ──────────────────────────────────────────────

/** Ceiling for one subscriber's unconsumed backlog. A consumer this far behind (a stalled remote
 *  connection — the wire's ReadableStream backpressure stops pulling while invokes keep pushing)
 *  has its buffer FROZEN at the cap (memory bounded — the actual goal: ≈10k small events ≈ a few
 *  MB worst case per stuck connection) and its subscription marked closed. The close is observed
 *  via pulls — which a stalled connection by definition does not make — so a consumer that RESUMES
 *  pulling first drains the frozen backlog, then gets done (no buffered event dropped), while a
 *  permanently stalled one holds the frozen buffer until its TCP connection dies. Recovery either
 *  way is the standard reconnect+backfill, semantically lossless. */
export const SUBSCRIBER_BUFFER_CAP = 10_000;

/** One subscriber's push→pull queue, capped at {@link SUBSCRIBER_BUFFER_CAP}. `close()` settles a
 *  pending pull — an async generator suspended on a quiet stream cannot be ended by `return()`
 *  alone (it queues behind the never-settling await), so teardown needs this explicit door. */
class Subscriber {
  /** For the overflow diagnostic only — a warn without the session is not actionable on a
   *  multi-session serve. (Explicit assignment: TS parameter properties break Node's strip-only
   *  type erasure, which the CLI runs under.) */
  private readonly session: string;
  constructor(session: string) {
    this.session = session;
  }
  private buffer: SessionEvent[] = [];
  // A QUEUE of waiters, not a single slot: concurrent next() calls are contract-legal (any wrapper
  // may poll twice), and a single `wake` field would let the second await overwrite the first's
  // resolver — hanging the first next() forever. Every wake flushes all waiters; each re-checks the
  // buffer and re-queues if another consumer won the event.
  private wakes: (() => void)[] = [];
  private closed = false;

  private flush(): void {
    const wakes = this.wakes;
    this.wakes = [];
    for (const wake of wakes) wake();
  }

  push(event: SessionEvent): void {
    if (this.closed) return;
    if (this.buffer.length >= SUBSCRIBER_BUFFER_CAP) {
      log.warn(
        `[fastagent] session-control subscriber for session "${this.session}" is ${SUBSCRIBER_BUFFER_CAP} events behind — no further events buffered; its stream ends after draining the backlog (or at connection death), then the client resyncs via entries()`,
      );
      this.close();
      return;
    }
    this.buffer.push(event);
    this.flush();
  }

  close(): void {
    this.closed = true;
    this.flush();
  }

  async next(): Promise<IteratorResult<SessionEvent>> {
    while (true) {
      if (this.buffer.length > 0) return { done: false, value: this.buffer.shift() as SessionEvent };
      if (this.closed) return { done: true, value: undefined };
      await new Promise<void>((resolve) => {
        this.wakes.push(resolve);
      });
    }
  }
}

// ── The hub ──────────────────────────────────────────────────────────────────

/** What the plane's writes (`update` / `compact` / `fork` / `delete`) need — the SAME instances the
 *  agent assembly uses: the lease (a write must not race a run), the model registry (validation +
 *  allowedModels), and the session factory (compaction is a model call). Writes go through the
 *  record the hub's reader opened — after an existence check, so the control plane never creates
 *  a session (that is the data plane's monopoly). */
export interface PiBoundaryWiring {
  lease: Lease;
  models: Models;
  sessionFactory: PiAgentSessionFactory;
  /** The assembly's configured PAIR — what a session with no overrides runs on. One field because
   *  model and thinking level are one setting: which levels exist is a property of the model, so a
   *  wiring that could carry them apart could carry a pair no run uses. Must be what
   *  {@link sessionFactory} was built with. */
  defaults: { model: AnyModel; thinkingLevel: ThinkingLevel };
}

export interface CreatePiSessionControlOptions {
  /** Read-only access to the durable session records (the same root the agent writes). */
  sessions: PiSessionRecordStore;
  /** Boundary-mutation wiring — the assembly's own parts. Absent → boundary commands are gated off
   *  in `capabilities()` and rejected `unsupported_capability`. */
  boundary?: PiBoundaryWiring;
  /** The definition's names, as an async thunk because the definition is live: this must re-read it,
   *  not close over a boot snapshot, or `commands()` would advertise a list the next turn no longer
   *  runs.
   *
   *  OPTIONAL because absence is a TRUE answer for the assembly that omits it: a hub over an L1
   *  agent (`createPiAgent({ model, instructions, tools })`) has no definition and therefore no
   *  names, and `[]` says exactly that. Wire it whenever the agent came from a DIRECTORY — there
   *  `[]` would be a lie; the directory constructor (`createPiAgentFromDir`) always does. */
  commands?: () => Promise<AgentCommand[]>;
  /** Tap for the events the HUB ITSELF generates (boundary mutations: `state_changed`,
   *  `compaction_*`) — those never pass through the data plane's observer seam, so a consumer
   *  composing a full-vocabulary tap wires the run events via the observer AND this. Called after
   *  the hub's own subscribers. */
  tap?: (session: string, event: SessionEvent) => void;
}

/**
 * Build the observation hub. Wire `observer` into the SAME agent assembly that serves the sessions:
 *
 * ```ts
 * const { control, observer } = createPiSessionControl({ sessions });
 * const agent = createPiAgent({ ..., sessions, observer });
 * ```
 */
export function createPiSessionControl(options: CreatePiSessionControlOptions): {
  control: SessionControl;
  observer: SessionObserver;
} {
  const { sessions, boundary } = options;
  /** Live run state per session — derived purely from run_started/run_settled and the controls
   *  registered with run_started. */
  const active = new Map<
    string,
    { runId: string; controls?: RunControls; pending: { steering: number; followUp: number } }
  >();
  const subscribers = new Map<string, Set<Subscriber>>();
  /** Sessions with a manual compaction in flight — reported as `status: "compacting"`, keyed to
   *  the summarization's AbortController so `abort` has a door into it (run/compaction symmetry:
   *  both are model calls a client must be able to stop). Set at ADMISSION, cleared by the
   *  detached task before `compaction_finished`. */
  const compacting = new Map<string, { abort: () => void }>();

  /** Fan an event out to this session's subscribers — shared by the observer (run events) and the
   *  boundary mutations (session-level events, no runId). */
  const fanOut = (session: string, event: SessionEvent): void => {
    const subs = subscribers.get(session);
    if (subs) for (const sub of [...subs]) sub.push(event);
  };

  /** Emit a HUB-generated event: subscribers first, then the external tap — the boundary-event
   *  half of a full-vocabulary tap (run events reach it through the observer composition). */
  const emitOwn = (session: string, event: SessionEvent): void => {
    fanOut(session, event);
    try {
      options.tap?.(session, event);
    } catch (error) {
      // Same discipline as the data plane's observer guard: a broken tap is its own problem.
      log.warn(`[fastagent] session-control tap threw (event ${event.type}): ${String(error)}`);
    }
  };

  const observer: SessionObserver = (session, event, run) => {
    if (event.type === "run_started" && event.runId) {
      active.set(session, { runId: event.runId, controls: run, pending: { steering: 0, followUp: 0 } });
    } else if (event.type === "run_settled") {
      active.delete(session);
    } else if (event.type === "queue_changed") {
      const entry = active.get(session);
      if (entry) entry.pending = event.data as { steering: number; followUp: number };
    }
    fanOut(session, event);
  };

  // The reads, plus the two sessionless declarations. Bound onto a handle below.
  const reads = {
    async commands(): Promise<AgentCommand[]> {
      return (await options.commands?.()) ?? [];
    },

    capabilities: (): SessionCapabilities => {
      const b = boundary;
      return {
        steering: true,
        followUp: true,
        compaction: !!b,
        // Every write — a property, a copied record, a removed one — needs the boundary wiring for
        // its LEASE, so they answer the same question: a write that races a run would hang the next
        // turn off a stale branch, or pull the record out from under it.
        fork: !!b,
        delete: !!b,
        // The CONTRACT's list, not a copy of it: a field added to SessionUpdate is advertised
        // without anyone remembering to, and one removed cannot linger here.
        updatable: b ? [...UPDATE_FIELDS] : [],
        // The registry is a deployment fact (any session may be pointed at any of it). Thinking
        // LEVELS are a property of the model a session is running, so they ride
        // `state().availableThinkingLevels` — a list here could only answer for one model.
        ...(b ? { allowedModels: listModels(b.models) } : {}),
        toolProgress: true, // tool_progress IS delivered (replace-semantics snapshots)
        usage: false,
      };
    },

    async state(session: string): Promise<SessionState> {
      const run = active.get(session);
      const opened = await sessions.openIfExists(session);
      const leafEntryId = opened ? publishedLeaf(opened) : undefined;
      // What will RUN, not the raw record: a client steering a session needs the pair that executes.
      // Without a boundary there is no model to resolve against, and the fields are absent.
      // OBSERVATION IS TOTAL: an unreadable entry chain leaves the pair absent too (the same shape a
      // control-less deployment answers with) rather than rejecting a read that has no error-code
      // channel to explain itself. The fault is not swallowed — it surfaces where codes exist: the
      // next invoke fails (binding a session walks the same chain) and a boundary dispatch answers
      // `boundary_command_failed`. Here it is a server-side warn.
      const b = boundary;
      let settings: ReturnType<typeof resolveSessionSettings> | undefined;
      if (opened && b) {
        try {
          settings = resolveSessionSettings(activePath(opened), b.models, b.defaults);
        } catch (error) {
          log.warn(`[fastagent] session ${session}: settings unreadable (entry chain): ${String(error)}`);
        }
      }
      const name = opened?.getSessionName();
      return {
        status: run ? "running" : compacting.has(session) ? "compacting" : "idle",
        ...(name ? { name } : {}),
        ...(run ? { activeRunId: run.runId } : {}),
        ...(settings
          ? {
              model: `${settings.model.provider}/${settings.model.id}`,
              thinkingLevel: settings.thinkingLevel,
              availableThinkingLevels: settings.availableThinkingLevels,
            }
          : {}),
        pending: run ? { ...run.pending } : { steering: 0, followUp: 0 },
        ...(leafEntryId ? { leafEntryId } : {}),
      };
    },

    async entries(session: string, opts?: { since?: string }): Promise<SessionEntries> {
      const opened = await sessions.openIfExists(session);
      if (!opened) return { entries: [] };
      // LEAF FIRST, then the journal: `getEntries()` hands back a SNAPSHOT, so reading it first
      // would race any concurrent append into a leaf the snapshot cannot contain — a live turn
      // reading as a dangling head. This order makes the journal a superset of the leaf's chain,
      // which is what lets the published head be trusted as one of the published entries.
      const leafEntryId = publishedLeaf(opened);
      const journal = opened.getEntries() as unknown as PiSessionEntry[];
      // The published tree must be SELF-CONTAINED: a `parentId` pointing at an entry this plane does
      // not publish (a label, one of our markers) would break the walk a client does from
      // `leafEntryId` upward — it would stop at an id it cannot look up and report a short path.
      // So a skipped entry is spliced out: its children point at the nearest published ancestor.
      const byId = new Map(journal.map((e) => [e.id, e]));
      const publishedParent = (entry: PiSessionEntry): string | undefined => {
        let parent = entry.parentId ?? undefined;
        while (parent) {
          const found = byId.get(parent);
          // A gap in the chain is left as a gap — `state()` reports it and the next invoke fails on
          // it (design §7); inventing a parent here would hide a corrupt journal.
          if (!found) return parent;
          if (isNavigable(found)) return parent;
          parent = found.parentId ?? undefined;
        }
        return undefined;
      };
      const all = journal.filter(isNavigable).map((e) => toSessionEntry(e, publishedParent(e)));
      let entries = all;
      if (opts?.since !== undefined) {
        const idx = all.findIndex((e) => e.id === opts.since);
        // Unknown cursor → full backfill (correct, merely larger): the client's cursor may predate
        // a repository the session was rebuilt into; silently skipping records would lose history.
        if (idx >= 0) entries = all.slice(idx + 1);
      }
      return { entries, ...(leafEntryId ? { leafEntryId } : {}) };
    },

    events(session: string): AsyncIterable<SessionEvent> {
      // EVERY ITERATION IS A FRESH SUBSCRIPTION — the per-subscription state lives inside
      // asyncIterator(), matching the remote client (one connection per iteration): two concurrent
      // iterations each get the full stream, and one iteration's end does not poison the next.
      // Registration happens on the FIRST next(), not at iterator creation: subscription semantics
      // = you are subscribed while you iterate; an iterator obtained but never driven must not
      // buffer. Teardown goes through Subscriber.close() so a `return()` on a QUIET stream
      // resolves promptly instead of queueing behind a never-settling pull — without it every
      // attach/detach against an idle session would leak a permanently registered subscriber.
      return {
        [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
          let sub: Subscriber | undefined;
          // `finished` is its own state: `sub === undefined` alone would conflate "not yet
          // registered" with "terminated", and a post-done next() would silently REGISTER A FRESH
          // subscription — the exact ghost-subscriber leak this class exists to prevent, reachable
          // by any wrapper that polls one extra time. done is terminal, per the iterator protocol.
          let finished = false;
          const cleanup = (): void => {
            finished = true;
            if (!sub) return;
            sub.close();
            const set = subscribers.get(session);
            if (set) {
              set.delete(sub);
              if (set.size === 0) subscribers.delete(session);
            }
            sub = undefined;
          };
          return {
            async next() {
              if (finished) return { done: true, value: undefined };
              if (!sub) {
                sub = new Subscriber(session);
                let set = subscribers.get(session);
                if (!set) {
                  set = new Set();
                  subscribers.set(session, set);
                }
                set.add(sub);
              }
              const result = await sub.next();
              if (result.done) cleanup();
              return result;
            },
            async return(value?: unknown) {
              cleanup();
              return { done: true as const, value: value as undefined };
            },
          };
        },
      };
    },
  };

  /** No boundary wiring — the write path does not exist in this deployment. A capability-gating
   *  client never lands here; one that does gets the same answer every gate publishes. */
  const unsupported = (what: string): SessionResult => ({
    ok: false,
    error: {
      code: UNSUPPORTED_CAPABILITY_CODE,
      message: `${what} is not supported by this runtime (no boundary wiring)`,
      retryable: false,
    },
  });

  const noSuchSession = (session: string): SessionResult => ({
    ok: false,
    error: { code: NO_SUCH_SESSION_CODE, message: `session "${session}" does not exist`, retryable: false },
  });

  const invalid = (message: string): SessionResult => ({
    ok: false,
    error: { code: INVALID_COMMAND_CODE, message, retryable: false },
  });

  const busy = (): SessionResult => ({
    ok: false,
    error: {
      code: SESSION_BUSY_CODE,
      message: "session busy: a run (or another write) is in flight — retry at idle",
      retryable: true,
    },
  });

  const failed = (error: unknown): SessionResult => ({
    ok: false,
    error: { code: BOUNDARY_COMMAND_FAILED_CODE, message: String(error), retryable: true },
  });

  /** steer / follow_up / abort — the run actions. They reach the LIVE run through the controls
   *  registered with `run_started`; nothing durable is written. */
  const runAction = async (session: string, action: SessionAction): Promise<SessionResult> => {
    const run = active.get(session);
    if (!run) {
      // Run/compaction symmetry: an in-flight compaction is a model call too, and `abort` is its
      // only door — interrupting it converges through the detached task's catch into
      // `compaction_finished{aborted}` with the lease released; answering no_active_run against a
      // state() that says "compacting" would be a lie.
      const comp = action.type === "abort" ? compacting.get(session) : undefined;
      if (comp) {
        comp.abort();
        return { ok: true }; // no runId — the outcome travels as compaction_finished{aborted}
      }
      // Rejected BEFORE acceptance: no run exists, nothing happened. retryable: false — the same
      // call fails again; call it after state() shows an active run.
      return {
        ok: false,
        error: {
          code: NO_ACTIVE_RUN_CODE,
          message: `no active run for this session — ${action.type} modulates a run an invoke is driving`,
          retryable: false,
        },
      };
    }
    if (!run.controls) {
      // A run EXISTS (state() rightly reports running) but was registered observation-only (the
      // observer seam allows run_started without controls). That is a CAPABILITY problem, not a run
      // problem — permanent for this wiring, so neither no_active_run (would poll forever) nor
      // run_command_failed (transient) fits.
      return {
        ok: false,
        error: {
          code: UNSUPPORTED_CAPABILITY_CODE,
          message: `the active run registered without modulation controls (observation-only) — ${action.type} cannot reach it`,
          retryable: false,
        },
      };
    }
    try {
      if (action.type === "steer") await run.controls.steer(action.prompt);
      else if (action.type === "follow_up") await run.controls.followUp(action.prompt);
      else await run.controls.abort();
    } catch (error) {
      // The run raced us to settlement, failed setup, or the engine refused: still pre-acceptance
      // (nothing was queued), distinct from "no run existed". retryable: false for the same reason —
      // the run is gone; consult state() before calling again.
      return { ok: false, error: { code: RUN_COMMAND_FAILED_CODE, message: String(error), retryable: false } };
    }
    // Accepted: joined (or stopped) THIS run. The outcome arrives as run_settled.
    return { ok: true, runId: run.runId };
  };

  /**
   * {@link Session.update} — validate the whole patch, take the lease once, hand the writes to the
   * store, report what landed.
   *
   * Everything before the lease is validation, which is what makes a rejected patch leave nothing
   * behind. What a value MEANS is decided here (a model spec against the registry, a level against
   * the model it lands on); how a record takes it is the store's.
   */
  const updateOf = async (session: string, patch: SessionUpdate): Promise<SessionResult> => {
    // Keys, not values: a field this runtime does not know must not be silently skipped — that is a
    // client typo, or a newer client talking to an older serve, and both need to hear about it.
    const named = Object.keys(patch) as SessionUpdateField[];
    const unknown = named.filter((f) => !UPDATE_FIELDS.includes(f));
    if (unknown.length > 0) {
      return unsupported(`update field(s) ${unknown.join(", ")} — capabilities().updatable lists what this serve sets`);
    }
    const fields = named.filter((f) => patch[f] !== undefined);
    if (fields.length === 0) return { ok: true }; // an empty patch asks for nothing, and gets it
    const b = boundary;
    if (!b) return unsupported(`update(${fields.join(", ")})`);

    // PAYLOAD validation first — before the session is even opened, and long before the lease: an
    // invalid value must not briefly block a run.
    let model: AnyModel | undefined;
    if (patch.model !== undefined) {
      const slash = patch.model.indexOf("/");
      model = slash > 0 ? b.models.getModel(patch.model.slice(0, slash), patch.model.slice(slash + 1)) : undefined;
      if (!model) {
        return invalid(`unknown model "${patch.model}" — capabilities().allowedModels lists the accepted specs`);
      }
    }
    if (patch.thinkingLevel !== undefined && !(THINKING_LEVELS as ReadonlySet<string>).has(patch.thinkingLevel)) {
      return invalid(
        `unknown thinking level "${patch.thinkingLevel}" — state().availableThinkingLevels lists what this session accepts`,
      );
    }
    // A name is the client's own label; the only thing that cannot be one is nothing.
    if (patch.name !== undefined && patch.name.trim() === "") return invalid("a session name cannot be empty");

    // Sessions are created by invoke or copied by fork, never minted by an update: an unknown id is
    // rejected, not turned into a ghost record. (Read-only handle — the WRITE one is opened under
    // the lease below, and this one is discarded.)
    const existing = await sessions.openIfExists(session);
    if (!existing) return noSuchSession(session);

    if (patch.leafEntryId !== undefined) {
      // A target that cannot BE a leaf is a permanent payload error, not a session error — the same
      // disposition as an unknown model spec. Same predicate `entries()` publishes by, so
      // "everything published is a position" holds by construction rather than by two literals
      // agreeing.
      const entry = existing.getEntry(patch.leafEntryId) as PiSessionEntry | undefined;
      if (!entry || !isNavigable(entry)) {
        return invalid(
          entry
            ? `entry "${patch.leafEntryId}" is not a position — entries() publishes every id you can move to, and this is not one of them`
            : `entry "${patch.leafEntryId}" does not exist in session "${session}" — entries() lists the positions`,
        );
      }
    }
    if (patch.thinkingLevel !== undefined) {
      // The same set `state()` showed the client. Reject here rather than record a level the run
      // would not use. The read is guarded because this must never REJECT — the contract promises a
      // SessionResult, so an unreadable chain has to arrive as a code.
      let resolved: ReturnType<typeof resolveSessionSettings>;
      try {
        // Against the path this patch LANDS on: a leaf move is written first, and the branch it
        // moves to can carry a model override of its own — validating on the path being left would
        // reject a level the destination supports, and accept one it does not.
        resolved = resolveSessionSettings(activePath(existing, patch.leafEntryId), b.models, b.defaults);
      } catch (error) {
        return failed(error);
      }
      // An explicit model in the same patch wins over the one that path resolves to: it is applied
      // after the move, so it is what the session ends up running.
      const target = model ?? resolved.model;
      const levels = model ? (getSupportedThinkingLevels(model) as string[]) : resolved.availableThinkingLevels;
      if (!levels.includes(patch.thinkingLevel)) {
        return invalid(
          `thinking level "${patch.thinkingLevel}" is not supported by ${target.provider}/${target.id} (allowed: ${levels.join(", ")})`,
        );
      }
    }

    // The control plane's writes take the same lease as every run — a write must never race one
    // (design §9).
    const release = b.lease.tryAcquire(session);
    if (!release) return busy();
    let applied: Awaited<ReturnType<PiSessionRecordStore["applyProperties"]>>;
    try {
      // HOW a record takes a property — order, the leaf pointer, the name pi rewrites — is the
      // store's to know. This asks for the writes and is told what landed.
      applied = await sessions.applyProperties(session, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
        ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
        ...(patch.leafEntryId !== undefined ? { leafEntryId: patch.leafEntryId } : {}),
      });
    } catch (error) {
      // Opening the record failed — nothing was written; the same patch may succeed on retry. The
      // lease is freed by the `finally` on the way out, once.
      return failed(error);
    } finally {
      release();
    }
    if (!applied) return noSuchSession(session); // vanished in the window: same condition, same code

    if (applied.landed.length > 0) {
      // ONE event for the patch, built from what the RECORD holds. The settings pair rides along
      // whenever anything but the name changed: model and thinking level are one setting, and a
      // moved leaf can drop an override that used to apply.
      let settings: ReturnType<typeof resolveSessionSettings> | undefined;
      if (applied.path) {
        try {
          settings = resolveSessionSettings(applied.path, b.models, b.defaults);
        } catch (error) {
          // Already durable, so an unresolvable pair must NOT read as "nothing took effect": report
          // the position without it and let the next invoke — which walks the same path — be where
          // the fault surfaces.
          log.warn(`[fastagent] session ${session}: updated, settings unresolvable: ${String(error)}`);
        }
      }
      emitOwn(session, {
        type: "state_changed",
        timestamp: Date.now(),
        data: {
          ...(applied.landed.includes("leafEntryId") ? { leafEntryId: applied.leafEntryId as string } : {}),
          ...(settings && applied.landed.some((f) => f !== "name")
            ? { model: `${settings.model.provider}/${settings.model.id}`, thinkingLevel: settings.thinkingLevel }
            : {}),
          ...(applied.landed.includes("name") && applied.name ? { name: applied.name } : {}),
        },
      });
    }
    if (applied.failure !== undefined) {
      // `boundary_command_failed` means nothing durable landed. When something did, the client needs
      // a different sentence — and the fields, so it knows what its retry would repeat.
      return applied.landed.length === 0
        ? failed(applied.failure)
        : {
            ok: false,
            error: {
              code: PARTIAL_UPDATE_CODE,
              message: `applied ${applied.landed.join(", ")}, then failed: ${String(applied.failure)} — read state() before retrying`,
              retryable: false,
            },
          };
    }
    return { ok: true };
  };

  /**
   * ACCEPT-FAST compaction: a full model call (tens of seconds is normal), so holding the call open
   * until it finishes would make acceptance = outcome — the one exception to §5.2, and what broke
   * remote clients whose request timeouts are sized for control calls. This answers once the work is
   * ADMITTED (lease held, session bound); the outcome travels as
   * `compaction_finished{summary|error|aborted}`.
   *
   * Admission is everything cheap and local: binding the session (the ONE canonical resolution of
   * overrides + auth) plus the compaction PREPARATION, a pure branch read. The boundary between
   * "reject" and "the outcome travels as an event" sits where the work becomes asynchronous and
   * expensive: the model call. "Nothing to compact" is therefore a pre-acceptance answer, never a
   * finished{error} dressed as a failure — pi reports it as a throw from compact(), too late.
   */
  const compactOf = async (session: string, instructions?: string): Promise<SessionResult> => {
    const b = boundary;
    if (!b) return unsupported("compact()");
    const existing = await sessions.openIfExists(session);
    if (!existing) return noSuchSession(session);
    const release = b.lease.tryAcquire(session);
    if (!release) return busy();

    let bound: Awaited<ReturnType<typeof b.sessionFactory>>;
    try {
      bound = await b.sessionFactory(session);
    } catch (error) {
      release();
      return failed(error);
    }
    const teardown = () => {
      try {
        bound.dispose();
      } catch (error) {
        log.warn(`[fastagent] compaction session teardown failed: ${String(error)}`);
      }
    };
    try {
      // The SAME settings pi will use inside compact(): asking with different thresholds would
      // either reject a compaction pi would have run, or admit one it refuses — and its refusal
      // arrives too late to be a pre-acceptance answer.
      const path = bound.sessionManager.getBranch();
      if (!hasCompactableHistory(path, bound.settingsManager.getCompactionSettings().keepRecentTokens)) {
        teardown();
        release();
        // A no-op, not a failure — its OWN code (the NO_ACTIVE_RUN pattern): a client must
        // machine-distinguish "give up" from "call again once the session grows", and branching on
        // message prose is forbidden by contract.
        return {
          ok: false,
          error: {
            code: NOTHING_TO_COMPACT_CODE,
            message: "nothing to compact — the session has no compactable history yet; retry after more turns",
            retryable: false,
          },
        };
      }
    } catch (error) {
      teardown();
      release();
      return failed(error);
    }
    // The door is the session's own compaction abort — a real one, unlike a summarization call with
    // no signal: `abort` must reach the model call (run/compaction symmetry).
    //
    // pi builds the controller that makes it abortable AFTER an internal await, so an abort arriving
    // in that window would find nothing to cancel and the compaction would run to completion — the
    // client's cancel silently doing nothing. The intent is latched and re-applied until it takes
    // (`isCompacting` reports when it has).
    //
    // The retry is DEFENSIVE: the window is one await wide, and the test below lands after it, so
    // this loop is not what makes that test pass. It is here because the window is on the code path,
    // not because it has been observed.
    let aborted = false;
    let running = true; // cleared when the compaction settles, however it settles
    const applyAbort = async () => {
      // WAIT for the controller rather than requiring it: an abort that arrives before pi builds one
      // sees isCompacting false, and a loop that only runs WHILE compacting would exit immediately —
      // leaving the intent unapplied in exactly the window it exists for.
      for (let attempt = 0; attempt < 200 && running; attempt++) {
        if (bound.isCompacting) {
          bound.abortCompaction();
          if (!bound.isCompacting) return; // it took
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };
    compacting.set(session, {
      abort: () => {
        aborted = true;
        bound.abortCompaction();
        void applyAbort();
      },
    });
    emitOwn(session, { type: "compaction_started", timestamp: Date.now(), data: {} });
    void (async () => {
      let outcome: { summary: string } | { error: string } | { aborted: true };
      // Retries are otherwise invisible between compaction_started and _finished — surface each
      // backoff so a long gap is diagnosable (not confusable with a hang): as a session event for
      // attached observers, as a warn for server logs.
      const unsub = bound.subscribe((event) => {
        if (event.type !== "summarization_retry_scheduled") return;
        log.warn(
          `[fastagent] compaction retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms (session ${session}): ${event.errorMessage}`,
        );
        emitOwn(session, {
          type: "retry_scheduled",
          timestamp: Date.now(),
          data: {
            operation: "compaction",
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            error: event.errorMessage,
          },
        } satisfies RetryScheduledEvent);
      });
      try {
        const done = await bound.compact(instructions);
        outcome = { summary: done.summary };
      } catch (error) {
        // A deliberate stop is not a failure — run/compaction symmetry with run_settled{aborted}:
        // the intent is the classification, same discipline as run abort attribution (a racing real
        // failure still reads as aborted).
        outcome = aborted ? { aborted: true } : { error: String(error) };
      }
      running = false;
      unsub();
      teardown();
      // Release BEFORE emitting finished: a watcher seeing finished may act next — "finished ⇒ the
      // lease is free and status is no longer compacting" must hold.
      compacting.delete(session);
      release();
      emitOwn(session, { type: "compaction_finished", timestamp: Date.now(), data: outcome });
    })();
    return { ok: true };
  };

  /**
   * Copy a history into a new session. IDEMPOTENT by construction: `into` is the caller's id, so a
   * repeat of a fork that already landed answers `ok: true` and writes nothing — a client retrying a
   * request whose response it never saw does not get a second record. Provenance is what makes that
   * safe rather than merely quiet: the same `into` naming a session that came from somewhere else is
   * a rejection, not an overwrite.
   */
  const forkOf = async (options: { from: string; at: string; into: string }): Promise<SessionResult> => {
    const { from, at, into } = options;
    /** WHICH fork this is: source + branch point. Two forks of one session at different entries are
     *  different requests, so a retry of one must not be answered by the other. */
    const provenance = `${from}@${at}`;
    const b = boundary;
    if (!b) return unsupported("fork()");
    // An id no client could then open: the empty string, `.` and `..` are not URL path segments
    // (isAddressableSession), so minting one would put a row in list() that nothing can address —
    // listed, unopenable by the client that just listed it.
    if (!isAddressableSession(into)) {
      return invalid(`${JSON.stringify(into)} cannot be a session id — the control plane could not address it`);
    }
    const source = await sessions.openIfExists(from);
    if (!source) return noSuchSession(from);
    // The entry predicate is the one `entries()` publishes by, so "everything published is forkable"
    // holds by construction — the same argument the leaf move makes.
    const entry = source.getEntry(at) as PiSessionEntry | undefined;
    if (!entry || !isNavigable(entry)) {
      return invalid(`entry "${at}" is not a forkable position in session "${from}" — entries() lists the ids`);
    }
    const existingTarget = await sessions.openIfExists(into);
    if (existingTarget) {
      // Already forked from HERE: the request already happened, so answering ok is the truth rather
      // than a convenience. Anything else under that id is a different history, and saying yes would
      // be the id lying about what it holds.
      return forkProvenance(existingTarget) === provenance
        ? { ok: true }
        : invalid(`session "${into}" already exists with a different history — fork mints nothing over it`);
    }

    // BOTH ends. The source lease keeps the copy from reading a history a run is mid-write on; the
    // destination lease closes the window the existence check above leaves open — an invoke creating
    // `into`, or a second fork from a DIFFERENT source (whose source lease is another key entirely),
    // otherwise lands between that check and this write. tryAcquire never blocks, so taking two
    // cannot deadlock.
    const release = b.lease.tryAcquire(from);
    if (!release) return busy();
    const releaseInto = b.lease.tryAcquire(into);
    if (!releaseInto) {
      release();
      return busy();
    }
    try {
      // Holding the lease is not the same as having looked: re-asked under it, as the update path
      // re-opens its record, so an id taken inside the window is a payload error rather than a
      // store failure the client would read as retryable.
      const raced = await sessions.openIfExists(into);
      if (raced) {
        return forkProvenance(raced) === provenance
          ? { ok: true }
          : invalid(`session "${into}" already exists with a different history — fork mints nothing over it`);
      }
      await sessions.fork(from, at, into, provenance);
    } catch (error) {
      // Nothing durable landed: the copy is staged and published by rename.
      return failed(error);
    } finally {
      releaseInto();
      release();
    }
    return { ok: true };
  };

  const deleteOf = async (session: string): Promise<SessionResult> => {
    const b = boundary;
    if (!b) return unsupported("delete()");
    const existing = await sessions.openIfExists(session);
    if (!existing) return noSuchSession(session);
    // The same lease as a run: a delete racing one would pull the record out from under it.
    const release = b.lease.tryAcquire(session);
    if (!release) return busy();
    try {
      // It was there before the lease and is gone now — the same real condition the check above
      // answers, so the same code.
      if (!(await sessions.delete(session))) return noSuchSession(session);
    } catch (error) {
      // A delete that throws left the record in place.
      return failed(error);
    } finally {
      release();
    }
    // The session is gone, so its live streams have nothing left to report: end them rather than
    // hold connections open on a record that no longer exists. A client's reconnect then reads an
    // empty `state()`, which is the truth.
    for (const sub of [...(subscribers.get(session) ?? [])]) sub.close();
    subscribers.delete(session);
    return { ok: true };
  };

  const control: SessionControl = {
    capabilities: reads.capabilities,
    commands: reads.commands,
    sessions: {
      // The one read that may REJECT (design §13): `[]` is what a deployment with no sessions
      // answers, so a store that cannot be read must not borrow that shape. The transport turns the
      // throw into a coded non-2xx; nothing here swallows it.
      list: () => sessions.list(),
      fork: forkOf,
      // A PURE BINDING: an id and the closures above it. Nothing is checked here — the calls answer
      // that, each in its own vocabulary — and nothing is cached, so two handles for one id are
      // interchangeable.
      get: (session: string): Session => ({
        id: session,
        state: () => reads.state(session),
        entries: (options) => reads.entries(session, options),
        events: () => reads.events(session),
        update: (patch) => updateOf(session, patch),
        steer: (prompt) => runAction(session, { type: "steer", prompt }),
        followUp: (prompt) => runAction(session, { type: "follow_up", prompt }),
        abort: () => runAction(session, { type: "abort" }),
        compact: (options) => compactOf(session, options?.instructions),
        delete: () => deleteOf(session),
      }),
    },
  };

  return { control, observer };
}
