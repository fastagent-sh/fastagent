/**
 * The pi implementation of the session control plane: observation (`state`/`entries`/`events`,
 * design Phase 1) and run modulation (`dispatch`: steer/follow_up/abort, Phase 2a) over
 * invoke-driven runs. `createPiSessionControl` returns the neutral `SessionControl` plus the
 * {@link SessionObserver} to plug into the invoke pipeline (`createPiAgentFromHarness({ observer })`)
 * — the hub derives everything from the rich event stream (plus the {@link RunControls} the
 * run_started event carries), holds no durable state of its own, and never writes: durable truth
 * stays in the session repository (read via {@link PiSessionReader}), live truth in the events the
 * data plane emits, modulation in the controls the data plane registers.
 *
 * Boundary mutations (Phase 2b: compact/set_model/set_thinking/navigate) take the same lease as runs;
 * without boundary wiring they are rejected before acceptance with `unsupported_capability` — a
 * client gating on `capabilities()` never sends them.
 */
import { DEFAULT_COMPACTION_SETTINGS, compact, prepareCompaction } from "@earendil-works/pi-agent-core";
import type { SessionTreeEntry, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { type Json, SESSION_BUSY_CODE } from "../../agent.ts";
import {
  type AgentCommand,
  BOUNDARY_COMMAND_FAILED_CODE,
  INVALID_COMMAND_CODE,
  NO_ACTIVE_RUN_CODE,
  NOTHING_TO_COMPACT_CODE,
  NO_SUCH_SESSION_CODE,
  RUN_COMMAND_FAILED_CODE,
  type RetryScheduledEvent,
  type SessionCapabilities,
  type SessionCommand,
  type SessionControl,
  type SessionEntries,
  type SessionEntry,
  type SessionEvent,
  type SessionResult,
  type SessionState,
  UNSUPPORTED_CAPABILITY_CODE,
} from "../../session.ts";
import { listModels } from "./config.ts";
import type { Lease, RunControls, SessionObserver } from "./invoke.ts";
import { type AnyModel, SUMMARIZATION_RETRY_POLICY, type PiHarnessFactory, harnessSession } from "./harness.ts";
import { THINKING_LEVELS, resolveSessionSettings } from "./session-settings.ts";
import { log } from "../../log.ts";
import { type PiSessionReader, activePathEntries } from "./sessions.ts";

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
 * pi `SessionTreeEntry` → neutral {@link SessionEntry}. Message entries map onto the guaranteed
 * kind vocabulary (user/assistant/tool) with a minimal render payload; every other engine record
 * keeps its pi type as an open-set kind with an EMPTY payload — present so `parentId` chains and
 * cursors stay intact, skippable by contract, and no pi message class leaks through the adapter.
 */
function toSessionEntry(entry: SessionTreeEntry): SessionEntry {
  const base = {
    id: entry.id,
    parentId: entry.parentId ?? undefined,
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

/**
 * THE invariant the client's rule rests on: everything `entries()` publishes is a legal `navigate`
 * target. pi's `leaf` records are the exception — they journal a MOVE rather than mark a position
 * (their parentId is the OLD leaf, nothing is ever chained onto them), so navigating to one would
 * put the branch head off every conversation path. Withheld from the published plane and refused as
 * a target THROUGH THIS ONE PREDICATE, so a second exclusion cannot make the two disagree.
 */
function isNavigable(entry: SessionTreeEntry): boolean {
  return entry.type !== "leaf";
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

/** What boundary mutations (compact / set_model / set_thinking / navigate) need — the SAME instances the
 *  agent assembly uses: the lease (mutations must not race a run), the model registry (validation +
 *  allowedModels), and the harness factory (compaction is a model call). Writes go through the
 *  session the hub's reader opened — after an existence check, so the control plane never creates
 *  a session (that is the data plane's monopoly). */
export interface PiBoundaryWiring {
  lease: Lease;
  models: Models;
  harnessFactory: PiHarnessFactory;
  /** The assembly's configured PAIR — what a session with no overrides runs on. One field because
   *  model and thinking level are one setting: which levels exist is a property of the model, so a
   *  wiring that could carry them apart could carry a pair no run uses. Must be what
   *  {@link harnessFactory} was built with. */
  defaults: { model: AnyModel; thinkingLevel: ThinkingLevel };
}

export interface CreatePiSessionControlOptions {
  /** Read-only access to the durable session repository (the same root the agent writes). */
  sessions: PiSessionReader;
  /** Boundary-mutation wiring, as a LAZY thunk: the hub's observer must exist before the agent
   *  assembly that produces these parts, so the hub asks for them at dispatch time instead
   *  (assembly completes before any dispatch can arrive). Absent / undefined → boundary commands
   *  are gated off in `capabilities()` and rejected `unsupported_capability`. */
  boundary?: () => PiBoundaryWiring | undefined;
  /** The definition's names, as a LAZY thunk for the same reason {@link boundary} is one (the hub
   *  exists before the assembly that can read a definition) — and async because the definition is
   *  live: this must re-read it, not close over a boot snapshot, or `commands()` would advertise a
   *  list the next turn no longer runs.
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
  const compacting = new Map<string, AbortController>();

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

  const control: SessionControl = {
    async commands(): Promise<AgentCommand[]> {
      return (await options.commands?.()) ?? [];
    },

    capabilities: (): SessionCapabilities => {
      const b = boundary?.();
      return {
        steering: true,
        followUp: true,
        manualCompaction: !!b,
        modelSelection: b ? { allowedModels: listModels(b.models) } : false,
        // Servable or not. WHICH levels is a property of the session's model, so it rides
        // `state().availableThinkingLevels` — a list here could only answer for one model.
        thinkingLevel: !!b,
        // Gated on the boundary wiring for its LEASE, not its models: moving the leaf is a write,
        // and a write that races a run would hang the next turn off a stale branch.
        navigate: !!b,
        toolProgress: true, // tool_progress IS delivered (replace-semantics snapshots)
        usage: false,
      };
    },

    async state(session): Promise<SessionState> {
      const run = active.get(session);
      const opened = await sessions.openIfExists(session);
      const leafEntryId = opened ? ((await opened.getLeafId()) ?? undefined) : undefined;
      // What will RUN, not the raw record: a client steering a session needs the pair that executes.
      // Without a boundary there is no model to resolve against, and the fields are absent.
      // OBSERVATION IS TOTAL: an unreadable entry chain leaves the pair absent too (the same shape a
      // control-less deployment answers with) rather than rejecting a read that has no error-code
      // channel to explain itself. The fault is not swallowed — it surfaces where codes exist: the
      // next invoke fails (the harness build walks the same chain) and a boundary dispatch answers
      // `boundary_command_failed`. Here it is a server-side warn.
      const b = boundary?.();
      let settings: ReturnType<typeof resolveSessionSettings> | undefined;
      if (opened && b) {
        try {
          settings = resolveSessionSettings(
            (await activePathEntries(opened)) as Parameters<typeof resolveSessionSettings>[0],
            b.models,
            b.defaults,
          );
        } catch (error) {
          log.warn(`[fastagent] session ${session}: settings unreadable (entry chain): ${String(error)}`);
        }
      }
      return {
        status: run ? "running" : compacting.has(session) ? "compacting" : "idle",
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

    async entries(session, opts): Promise<SessionEntries> {
      const opened = await sessions.openIfExists(session);
      if (!opened) return { entries: [] };
      // LEAF FIRST, then the journal: `getEntries()` hands back a SNAPSHOT, so reading it first
      // would race any concurrent append into a leaf the snapshot cannot contain — a live turn
      // reading as a dangling head. This order makes the journal a superset of the leaf's chain,
      // which is what lets the published head be trusted as one of the published entries.
      const leafEntryId = (await opened.getLeafId()) ?? undefined;
      const all = (await opened.getEntries()).filter(isNavigable).map(toSessionEntry);
      let entries = all;
      if (opts?.since !== undefined) {
        const idx = all.findIndex((e) => e.id === opts.since);
        // Unknown cursor → full backfill (correct, merely larger): the client's cursor may predate
        // a repository the session was rebuilt into; silently skipping records would lose history.
        if (idx >= 0) entries = all.slice(idx + 1);
      }
      return { entries, ...(leafEntryId ? { leafEntryId } : {}) };
    },

    events(session): AsyncIterable<SessionEvent> {
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

    async dispatch(session, command: SessionCommand): Promise<SessionResult> {
      switch (command.type) {
        case "steer":
        case "follow_up":
        case "abort": {
          const run = active.get(session);
          if (!run) {
            // Run/compaction symmetry: an in-flight manual compaction is a model call too, and
            // `abort` is its only door — interrupting the harness converges through the detached
            // task's catch into `compaction_finished{aborted}` with the lease released; answering
            // no_active_run against a state() that says "compacting" would be a lie.
            const comp = command.type === "abort" ? compacting.get(session) : undefined;
            if (comp) {
              comp.abort();
              return { ok: true }; // no runId — the outcome travels as compaction_finished{aborted}
            }
            // Rejected BEFORE acceptance: no run exists, nothing happened. retryable: false —
            // as-is retry fails again; re-dispatch after state() shows an active run.
            return {
              ok: false,
              error: {
                code: NO_ACTIVE_RUN_CODE,
                message: `no active run for this session — ${command.type} modulates a run an invoke is driving`,
                retryable: false,
              },
            };
          }
          if (!run.controls) {
            // A run EXISTS (state() rightly reports running) but was registered observation-only
            // (the observer seam allows run_started without controls). That is a CAPABILITY
            // problem, not a run problem — permanent for this wiring, so neither no_active_run
            // (would poll forever) nor run_command_failed (transient) fits.
            return {
              ok: false,
              error: {
                code: UNSUPPORTED_CAPABILITY_CODE,
                message: `the active run registered without modulation controls (observation-only) — ${command.type} cannot reach it`,
                retryable: false,
              },
            };
          }
          try {
            if (command.type === "steer") await run.controls.steer(command.prompt);
            else if (command.type === "follow_up") await run.controls.followUp(command.prompt);
            else await run.controls.abort();
          } catch (error) {
            // The run raced us to settlement, failed setup, or the engine refused: still
            // pre-acceptance (nothing was queued), distinct from "no run existed". retryable:
            // false for the same reason — the run is gone; consult state() before re-dispatching.
            return {
              ok: false,
              error: { code: RUN_COMMAND_FAILED_CODE, message: String(error), retryable: false },
            };
          }
          // Accepted: joined (or stopped) THIS run. The outcome arrives as run_settled.
          return { ok: true, runId: run.runId };
        }
        case "compact":
        case "set_model":
        case "set_thinking":
        case "navigate": {
          const b = boundary?.();
          if (!b) {
            // No boundary wiring: rejected before acceptance; a capability-gating client never
            // lands here.
            return {
              ok: false,
              error: {
                code: UNSUPPORTED_CAPABILITY_CODE,
                message: `command "${command.type}" is not supported by this runtime (no boundary wiring)`,
                retryable: false,
              },
            };
          }
          // Payload validation BEFORE the lease — an invalid value must not briefly block a run.
          /** The durable write for set_model/set_thinking/navigate — undefined for compact (harness
           *  path). Answers the event to emit. */
          let apply: ((session: import("@earendil-works/pi-agent-core").Session) => Promise<SessionEvent>) | undefined;
          if (command.type === "set_model") {
            const slash = command.model.indexOf("/");
            const model =
              slash > 0 ? b.models.getModel(command.model.slice(0, slash), command.model.slice(slash + 1)) : undefined;
            if (!model) {
              return {
                ok: false,
                error: {
                  code: INVALID_COMMAND_CODE,
                  message: `unknown model "${command.model}" — capabilities().modelSelection lists the allowed specs`,
                  retryable: false,
                },
              };
            }
            apply = async (s) => {
              await s.appendModelChange(model.provider, model.id);
              // Both halves: a new model can change which level executes. Nothing is re-recorded to
              // make that true — the resolve reports it, so the preference survives a round trip.
              const settings = resolveSessionSettings(
                (await activePathEntries(s)) as Parameters<typeof resolveSessionSettings>[0],
                b.models,
                b.defaults,
              );
              return {
                type: "state_changed",
                timestamp: Date.now(),
                // The CANONICAL spec, same string the durable entry and state() report — the event
                // must not echo a client alias the other two surfaces would disagree with.
                data: { model: `${model.provider}/${model.id}`, thinkingLevel: settings.thinkingLevel },
              };
            };
          } else if (command.type === "set_thinking") {
            // A payload that is not a level at all — invalid before any session question.
            if (!(THINKING_LEVELS as ReadonlySet<string>).has(command.level)) {
              return {
                ok: false,
                error: {
                  code: INVALID_COMMAND_CODE,
                  message: `unknown thinking level "${command.level}" — state().availableThinkingLevels lists what this session accepts`,
                  retryable: false,
                },
              };
            }
            apply = async (s) => {
              await s.appendThinkingLevelChange(command.level);
              return { type: "state_changed", timestamp: Date.now(), data: { thinkingLevel: command.level } };
            };
          } else if (command.type === "navigate") {
            apply = async (s) => {
              // A move to where the leaf already is writes nothing: pi journals a move as a `leaf`
              // record, so an idempotent re-dispatch (a client retry, a UI firing on every
              // selection) would otherwise grow the session by a record no plane publishes. The
              // EVENT is emitted either way — it reports the resulting position, not the fact that
              // a record was written, and a client that dispatched must not have to poll for it.
              if ((await s.getLeafId()) !== command.targetId) await s.moveTo(command.targetId);
              // moveTo's postcondition IS "targetId is the leaf" (it validates, then sets); a
              // failure throws and travels as boundary_command_failed, so a read-back could only
              // re-report what this line already knows. The SETTINGS ride along because a move can
              // change them — an override recorded on the branch just left stops applying, and a
              // client tracking model/level from the event stream would otherwise show what the
              // next turn will not use.
              // The move is already durable here, so a settings read that throws (the new path is
              // above a gap) must NOT turn into "nothing took effect": report the position without
              // the settings and let `state()`'s rejection be where the broken chain surfaces.
              let settings: ReturnType<typeof resolveSessionSettings> | undefined;
              try {
                settings = resolveSessionSettings(
                  (await activePathEntries(s)) as Parameters<typeof resolveSessionSettings>[0],
                  b.models,
                  b.defaults,
                );
              } catch (error) {
                // Absent rather than stale: the session cannot RUN with an unreadable chain either
                // (the harness build walks the same path), so the next invoke fails visibly — this
                // event does not need to carry a second signal for it.
                log.warn(`[fastagent] session ${session}: leaf moved, settings unreadable: ${String(error)}`);
              }
              return {
                type: "state_changed",
                timestamp: Date.now(),
                data: {
                  leafEntryId: command.targetId,
                  ...(settings
                    ? {
                        model: `${settings.model.provider}/${settings.model.id}`,
                        thinkingLevel: settings.thinkingLevel,
                      }
                    : {}),
                },
              };
            };
          }
          // Sessions are created by invoke, never here: a mutation on an unknown id is rejected,
          // not minted into a ghost record. (Existence check before the lease — read-only; the
          // WRITE handle is re-opened under the lease below, this one is discarded.)
          const existing = await sessions.openIfExists(session);
          if (!existing) {
            return {
              ok: false,
              error: {
                code: NO_SUCH_SESSION_CODE,
                message: `session "${session}" does not exist — sessions are created by invoke, not by boundary mutations`,
                retryable: false,
              },
            };
          }
          if (command.type === "navigate") {
            // A target that cannot BE a leaf is a permanent payload error, not a session error — the
            // same disposition as an unknown model spec. Same predicate `entries()` publishes by, so
            // "everything published is navigable" holds by construction rather than by two literals
            // agreeing.
            const entry = await existing.getEntry(command.targetId);
            if (!entry || !isNavigable(entry)) {
              return {
                ok: false,
                error: {
                  code: INVALID_COMMAND_CODE,
                  message: entry
                    ? `entry "${command.targetId}" is a leaf-move record — entries() does not publish those, and they are not positions; navigate to the entry it points at`
                    : `entry "${command.targetId}" does not exist in session "${session}" — entries() lists the navigable ids`,
                  retryable: false,
                },
              };
            }
          }
          if (command.type === "set_thinking") {
            // The same set `state()` showed the client. Reject here rather than record a level the
            // run would not use. The read is guarded because `dispatch` must never REJECT — the
            // transport promises a SessionResult, so an unreadable chain has to arrive as a code.
            let resolved: ReturnType<typeof resolveSessionSettings>;
            try {
              resolved = resolveSessionSettings(
                (await activePathEntries(existing)) as Parameters<typeof resolveSessionSettings>[0],
                b.models,
                b.defaults,
              );
            } catch (error) {
              return {
                ok: false,
                error: { code: BOUNDARY_COMMAND_FAILED_CODE, message: String(error), retryable: true },
              };
            }
            const { model, availableThinkingLevels } = resolved;
            if (!availableThinkingLevels.includes(command.level)) {
              return {
                ok: false,
                error: {
                  code: INVALID_COMMAND_CODE,
                  message: `thinking level "${command.level}" is not supported by ${model.provider}/${model.id} (allowed: ${availableThinkingLevels.join(", ")})`,
                  retryable: false,
                },
              };
            }
          }
          // Boundary mutations are the control plane's only writers: same lease as every run — a
          // mutation must never race one (design §9).
          const release = b.lease.tryAcquire(session);
          if (!release) {
            return {
              ok: false,
              error: {
                code: SESSION_BUSY_CODE,
                message: "session busy: a run (or another boundary mutation) is in flight — retry at idle",
                retryable: true,
              },
            };
          }
          if (command.type === "compact") {
            // ACCEPT-FAST: compaction is a full model call (tens of seconds is normal) — holding
            // the dispatch open until it finishes made acceptance = outcome, the one exception to
            // §5.2, and broke remote clients whose request timeouts are sized for control calls.
            // The dispatch answers once the work is ADMITTED (lease held, harness built); the
            // outcome travels as compaction_finished{summary|error|aborted}, the bounds contract watchers
            // already rely on. Pre-acceptance failures (the harness build) still reject here.
            // The admission step is EVERYTHING cheap and local: the harness build (the ONE
            // canonical resolution of session overrides + auth) plus the compaction PREPARATION
            // (a pure branch-read computation) — the boundary between "reject the dispatch" and
            // "outcome travels as an event" sits where the work becomes asynchronous and
            // expensive: the model call. "Nothing to compact" is thus a pre-acceptance answer,
            // never a finished{error} dressed as a failure. The summarization runs through pi's
            // compaction primitives instead of harness.compact() for exactly one reason: the
            // harness surface passes no signal to its model call, so an in-flight compaction
            // would be uncancellable — and `abort` needs a real door (run/compaction symmetry).
            let harness: Awaited<ReturnType<typeof b.harnessFactory>>;
            try {
              harness = await b.harnessFactory(session);
            } catch (error) {
              release();
              return {
                ok: false,
                error: { code: BOUNDARY_COMMAND_FAILED_CODE, message: String(error), retryable: true },
              };
            }
            const teardown = async () => {
              try {
                await harness.abort(); // fresh-harness discipline
              } catch (error) {
                log.warn(`[fastagent] compaction harness teardown failed: ${String(error)}`);
              }
            };
            let record: NonNullable<ReturnType<typeof harnessSession>>;
            let preparation: Parameters<typeof compact>[0];
            try {
              const bound = harnessSession(harness);
              if (!bound) throw new Error("harness has no bound session (factory invariant broken)");
              record = bound;
              const prep = prepareCompaction(await record.getBranch(), DEFAULT_COMPACTION_SETTINGS);
              if (!prep.ok) throw prep.error;
              if (!prep.value) {
                await teardown();
                release();
                // A no-op, not a failure — its OWN code (the NO_ACTIVE_RUN pattern): a client must
                // machine-distinguish "give up" from "re-dispatch once the session grows", and
                // branching on message prose is forbidden by contract.
                return {
                  ok: false,
                  error: {
                    code: NOTHING_TO_COMPACT_CODE,
                    message: "nothing to compact — the session has no compactable history yet; retry after more turns",
                    retryable: false,
                  },
                };
              }
              preparation = prep.value;
            } catch (error) {
              await teardown();
              release();
              return {
                ok: false,
                error: { code: BOUNDARY_COMMAND_FAILED_CODE, message: String(error), retryable: true },
              };
            }
            const door = new AbortController();
            compacting.set(session, door); // admission complete: from here `abort` reaches the model call
            emitOwn(session, { type: "compaction_started", timestamp: Date.now(), data: {} });
            void (async () => {
              let outcome: { summary: string } | { error: string } | { aborted: true };
              try {
                const done = await compact(
                  preparation,
                  b.models,
                  harness.getModel(),
                  command.instructions,
                  door.signal,
                  harness.getThinkingLevel(),
                  SUMMARIZATION_RETRY_POLICY,
                  {
                    // Retries are otherwise invisible between compaction_started and _finished —
                    // surface each backoff so a long gap is diagnosable (not confusable with a
                    // hang): as a session event for attached observers, as a warn for server logs.
                    onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
                      log.warn(
                        `[fastagent] compaction retry ${attempt}/${maxAttempts} in ${delayMs}ms (session ${session}): ${errorMessage}`,
                      );
                      emitOwn(session, {
                        type: "retry_scheduled",
                        timestamp: Date.now(),
                        data: { operation: "compaction", attempt, maxAttempts, delayMs, error: errorMessage },
                      } satisfies RetryScheduledEvent);
                    },
                  },
                );
                if (!done.ok) throw done.error;
                await record.appendCompaction(
                  done.value.summary,
                  done.value.firstKeptEntryId,
                  done.value.tokensBefore,
                  done.value.details,
                );
                outcome = { summary: done.value.summary };
              } catch (error) {
                // A deliberate stop is not a failure — run/compaction symmetry with
                // run_settled{aborted}: the door's signal is the classification, same discipline
                // as run abort attribution (a racing real failure still reads as aborted — the
                // intent was live while the work resolved).
                outcome = door.signal.aborted ? { aborted: true } : { error: String(error) };
              }
              await teardown();
              // Release BEFORE emitting finished: a watcher seeing finished may dispatch next —
              // "finished ⇒ the lease is free and status is no longer compacting" must hold.
              compacting.delete(session);
              release();
              emitOwn(session, { type: "compaction_finished", timestamp: Date.now(), data: outcome });
            })();
            return { ok: true };
          }
          try {
            // The WRITE handle is opened UNDER the lease: a handle from before tryAcquire could
            // be a stale snapshot of a run that completed in the window — appending to it would
            // hang the override off an outdated leaf.
            const fresh = await sessions.openIfExists(session);
            if (!fresh) {
              // Same real condition as the pre-lease check (the session vanished in the window):
              // same code, same disposition — not a retryable internal error.
              return {
                ok: false,
                error: {
                  code: NO_SUCH_SESSION_CODE,
                  message: `session "${session}" does not exist — sessions are created by invoke, not by boundary mutations`,
                  retryable: false,
                },
              };
            }
            // Unreachable by construction: only set_model/set_thinking/navigate reach this branch,
            // and all three assign `apply` in validation. Throw rather than silently skip (fail visibly).
            if (!apply) throw new Error("apply unset outside the compact branch (dispatch invariant broken)");
            emitOwn(session, await apply(fresh));
          } catch (error) {
            // The append failed before anything durable landed — "nothing took effect"; the same
            // command may succeed on retry.
            return {
              ok: false,
              error: { code: BOUNDARY_COMMAND_FAILED_CODE, message: String(error), retryable: true },
            };
          } finally {
            release();
          }
          return { ok: true };
        }
        default:
          // Wire input bypasses the TS union (a remote client can send any `type`): a protocol-
          // level answer, never an undefined body — the transport promises `ok: false` shapes.
          return {
            ok: false,
            error: {
              code: INVALID_COMMAND_CODE,
              message: `unknown command type "${String((command as { type?: unknown }).type)}"`,
              retryable: false,
            },
          };
      }
    },
  };

  return { control, observer };
}
