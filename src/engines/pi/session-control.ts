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
 * Phase 2b (boundary mutations: compact/set_model/set_thinking) is still rejected before acceptance
 * with `unsupported_capability` — a client gating on `capabilities()` never sends them.
 */
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { type Json, SESSION_BUSY_CODE } from "../../agent.ts";
import {
  BOUNDARY_COMMAND_FAILED_CODE,
  INVALID_COMMAND_CODE,
  NO_ACTIVE_RUN_CODE,
  NO_SUCH_SESSION_CODE,
  RUN_COMMAND_FAILED_CODE,
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
import { type PiHarnessFactory, THINKING_LEVELS } from "./harness.ts";
import { log } from "../../log.ts";
import type { PiSessionReader } from "./sessions.ts";

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

// ── Live fan-out (events plane) ──────────────────────────────────────────────

/** One subscriber's unbounded push→pull queue. Ends only when the CONSUMER stops iterating. */
class Subscriber {
  private buffer: SessionEvent[] = [];
  private wake?: () => void;

  push(event: SessionEvent): void {
    this.buffer.push(event);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  async *iterate(): AsyncGenerator<SessionEvent> {
    while (true) {
      while (this.buffer.length > 0) yield this.buffer.shift() as SessionEvent;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

// ── The hub ──────────────────────────────────────────────────────────────────

/** What boundary mutations (compact / set_model / set_thinking) need — the SAME instances the
 *  agent assembly uses: the lease (mutations must not race a run), the model registry (validation +
 *  allowedModels), and the harness factory (compaction is a model call). Writes go through the
 *  session the hub's reader opened — after an existence check, so the control plane never creates
 *  a session (that is the data plane's monopoly). */
export interface PiBoundaryWiring {
  lease: Lease;
  models: Models;
  harnessFactory: PiHarnessFactory;
}

export interface CreatePiSessionControlOptions {
  /** Read-only access to the durable session repository (the same root the agent writes). */
  sessions: PiSessionReader;
  /** Boundary-mutation wiring, as a LAZY thunk: the hub's observer must exist before the agent
   *  assembly that produces these parts, so the hub asks for them at dispatch time instead
   *  (assembly completes before any dispatch can arrive). Absent / undefined → boundary commands
   *  are gated off in `capabilities()` and rejected `unsupported_capability`. */
  boundary?: () => PiBoundaryWiring | undefined;
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
  /** Sessions with a manual compaction in flight — reported as `status: "compacting"`. */
  const compacting = new Set<string>();

  /** Fan an event out to this session's subscribers — shared by the observer (run events) and the
   *  boundary mutations (session-level events, no runId). */
  const fanOut = (session: string, event: SessionEvent): void => {
    const subs = subscribers.get(session);
    if (subs) for (const sub of [...subs]) sub.push(event);
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
    capabilities: (): SessionCapabilities => {
      const b = boundary?.();
      return {
        steering: true,
        followUp: true,
        manualCompaction: !!b,
        modelSelection: b ? { allowedModels: listModels(b.models) } : false,
        thinkingLevel: b ? { allowedLevels: [...THINKING_LEVELS] as string[] } : false,
        toolProgress: true, // tool_progress IS delivered (replace-semantics snapshots)
        usage: false,
      };
    },

    async state(session): Promise<SessionState> {
      const run = active.get(session);
      const opened = await sessions.openIfExists(session);
      const leafEntryId = opened ? ((await opened.getLeafId()) ?? undefined) : undefined;
      // The durable overrides (set_model / set_thinking): the LAST record of each kind — what a
      // reconnecting client needs without scanning entries itself. Reported as recorded, even if
      // the current registry lacks the model (state reports session truth; the harness resolve
      // owns the execution fallback).
      let model: string | undefined;
      let thinkingLevel: string | undefined;
      if (opened) {
        const entries = await opened.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i] as { type: string; provider?: string; modelId?: string; thinkingLevel?: string };
          if (model === undefined && e.type === "model_change") model = `${e.provider}/${e.modelId}`;
          if (thinkingLevel === undefined && e.type === "thinking_level_change") thinkingLevel = e.thinkingLevel;
          if (model !== undefined && thinkingLevel !== undefined) break;
        }
      }
      return {
        status: run ? "running" : compacting.has(session) ? "compacting" : "idle",
        ...(run ? { activeRunId: run.runId } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        pending: run ? { ...run.pending } : { steering: 0, followUp: 0 },
        ...(leafEntryId ? { leafEntryId } : {}),
      };
    },

    async entries(session, opts): Promise<SessionEntries> {
      const opened = await sessions.openIfExists(session);
      if (!opened) return { entries: [] };
      const all = (await opened.getEntries()).map(toSessionEntry);
      const leafEntryId = (await opened.getLeafId()) ?? undefined;
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
      // Registration happens INSIDE the generator body (on first next()), not at call time:
      // subscription semantics = you are subscribed while you iterate. An iterable that is obtained
      // but never iterated must not register — it would buffer the session's events forever with no
      // way to release them (the only unregistration path is the generator's own finally).
      return (async function* iterate(): AsyncGenerator<SessionEvent> {
        const sub = new Subscriber();
        let set = subscribers.get(session);
        if (!set) {
          set = new Set();
          subscribers.set(session, set);
        }
        set.add(sub);
        try {
          yield* sub.iterate();
        } finally {
          set.delete(sub);
          if (set.size === 0) subscribers.delete(session);
        }
      })();
    },

    async dispatch(session, command: SessionCommand): Promise<SessionResult> {
      switch (command.type) {
        case "steer":
        case "follow_up":
        case "abort": {
          const run = active.get(session);
          if (!run) {
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
        case "set_thinking": {
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
          let apply: (session: import("@earendil-works/pi-agent-core").Session) => Promise<SessionEvent | undefined>;
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
              // The CANONICAL spec, same string the durable entry and state() report — the event
              // must not echo a client alias the other two surfaces would disagree with.
              return { type: "state_changed", timestamp: Date.now(), data: { model: `${model.provider}/${model.id}` } };
            };
          } else if (command.type === "set_thinking") {
            if (!(THINKING_LEVELS as ReadonlySet<string>).has(command.level)) {
              return {
                ok: false,
                error: {
                  code: INVALID_COMMAND_CODE,
                  message: `unknown thinking level "${command.level}" — capabilities().thinkingLevel lists the allowed values`,
                  retryable: false,
                },
              };
            }
            apply = async (s) => {
              await s.appendThinkingLevelChange(command.level);
              return { type: "state_changed", timestamp: Date.now(), data: { thinkingLevel: command.level } };
            };
          } else {
            apply = async () => undefined; // compact runs through the harness below, not an entry append
          }
          // Sessions are created by invoke, never here: a mutation on an unknown id is rejected,
          // not minted into a ghost record. (Existence check before the lease — read-only.)
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
          try {
            if (command.type === "compact") {
              compacting.add(session);
              fanOut(session, { type: "compaction_started", timestamp: Date.now(), data: {} });
              // Compaction is a model call: build the session's full harness (the factory applies
              // the session's own model/thinking overrides) and tear it down after. Every started
              // is CLOSED: success → finished{summary}; failure → finished{error} (the bounds
              // contract — an events-only watcher must never hang on an open compaction).
              const harness = await b.harnessFactory(session);
              try {
                const result = await harness.compact(command.instructions);
                fanOut(session, {
                  type: "compaction_finished",
                  timestamp: Date.now(),
                  data: { summary: result.summary },
                });
              } catch (error) {
                fanOut(session, {
                  type: "compaction_finished",
                  timestamp: Date.now(),
                  data: { error: String(error) },
                });
                throw error; // → the shared catch below returns boundary_command_failed
              } finally {
                try {
                  await harness.abort(); // teardown — fresh-harness discipline (never throws past here)
                } catch (error) {
                  log.warn(`[fastagent] compaction harness teardown failed: ${String(error)}`);
                }
              }
            } else {
              const event = await apply(existing);
              if (event) fanOut(session, event);
            }
          } catch (error) {
            // Admitted but nothing durable landed (pi appends the compaction entry only at the
            // end): still "nothing took effect" — the same command may succeed on retry.
            return {
              ok: false,
              error: { code: BOUNDARY_COMMAND_FAILED_CODE, message: String(error), retryable: true },
            };
          } finally {
            compacting.delete(session);
            release();
          }
          return { ok: true };
        }
      }
    },
  };

  return { control, observer };
}
