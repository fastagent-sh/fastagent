/**
 * Session control plane — the engine-neutral serving extension beside Agent Handler
 * (docs/design/session-control.md). Pure types, zero dependencies; importing any engine
 * implementation here is forbidden, exactly like agent.ts.
 *
 * The plane model: `invoke` is the only data plane (no run exists without an invoke); `dispatch`
 * modulates the run an invoke drives; `state`/`entries`/`events` observe, strictly read-only.
 */
import type { Json, Prompt } from "./agent.ts";

// ── Contract ─────────────────────────────────────────────────────────────────

export interface SessionControl {
  capabilities(): SessionCapabilities;
  state(session: string): Promise<SessionState>;
  /** `since` is an APPEND-ORDER position cursor: "every record appended after the one with this
   *  id", regardless of branch structure. Reconstructing the active path in a branched session is
   *  the client's job via `parentId` chains from `leafEntryId`. An unknown cursor falls back to a
   *  full backfill (correct, merely larger). */
  entries(session: string, options?: { since?: string }): Promise<SessionEntries>;
  events(session: string): AsyncIterable<SessionEvent>;
  dispatch(session: string, command: SessionCommand): Promise<SessionResult>;
}

/**
 * Static support declaration, two kinds of flag:
 * - COMMAND GATES (`steering`, `followUp`, `manualCompaction`, `modelSelection`, `thinkingLevel`):
 *   clients MUST gate dispatch on them; an unsupported command is rejected before acceptance with
 *   {@link UNSUPPORTED_CAPABILITY_CODE}.
 * - OBSERVATION-QUALITY flags (`toolProgress`, `usage`): whether those events/state fields appear
 *   at all — nothing to dispatch, nothing to reject.
 * `state`/`entries`/`events` are mandatory (the reconnect contract) and deliberately absent here.
 */
export interface SessionCapabilities {
  steering: boolean;
  followUp: boolean;
  manualCompaction: boolean;
  modelSelection: false | { allowedModels: string[] };
  thinkingLevel: false | { allowedLevels: string[] };
  toolProgress: boolean;
  usage: boolean;
}

/** Stable `SessionResult.error.code` for a command the implementation does not support. */
export const UNSUPPORTED_CAPABILITY_CODE = "unsupported_capability";

/** Stable `SessionResult.error.code` for a run-modulating command (`steer`/`follow_up`/`abort`)
 *  dispatched while the session has no active run. `retryable: false` — re-dispatching as-is
 *  fails again; re-dispatch only after `state()` shows an active run. */
export const NO_ACTIVE_RUN_CODE = "no_active_run";

/** Stable `SessionResult.error.code` for a run command that reached a run but could not take
 *  effect. Distinct from {@link NO_ACTIVE_RUN_CODE}: the run existed. Two situations share it —
 *  the run raced to settlement (gone by now), or the runtime registered the run without
 *  modulation controls (observation-only; still running). `state()` alone cannot disambiguate;
 *  inspect `error.message`. Still pre-acceptance — nothing was queued — and `retryable: false`:
 *  the same command as-is fails again. */
export const RUN_COMMAND_FAILED_CODE = "run_command_failed";

// ── Commands (control plane) ─────────────────────────────────────────────────

/** Six commands; deliberately NO `prompt` — starting work is the data plane's definition. */
export type SessionCommand =
  | { type: "steer"; prompt: Prompt }
  | { type: "follow_up"; prompt: Prompt }
  | { type: "abort" }
  | { type: "compact"; instructions?: string }
  | { type: "set_model"; model: string }
  | { type: "set_thinking"; level: string };

/**
 * Acceptance is not outcome: `ok: true` means admitted or applied, never that the run ultimately
 * succeeded (outcomes are `run_settled` events / the invoke terminal). `ok: false` is guaranteed to
 * mean rejection BEFORE acceptance — nothing took effect. `error.retryable` means "re-dispatching
 * the SAME command as-is may succeed"; a `false` with a state-dependent code (e.g.
 * {@link NO_ACTIVE_RUN_CODE}) invites a re-dispatch only after `state()` shows the condition
 * changed.
 */
export type SessionResult =
  | { ok: true; runId?: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

// ── State and durable entries (observation plane) ────────────────────────────

export interface SessionState {
  /** `compacting` refers to Phase 2 MANUAL compaction at a session boundary. Automatic overflow
   *  compaction happens inside a run's activity window and reports as `running`. */
  status: "idle" | "running" | "compacting";
  activeRunId?: string;
  model?: string;
  thinkingLevel?: string;
  pending: { steering: number; followUp: number };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cost?: number;
    contextTokens?: number;
    contextWindow?: number;
  };
  leafEntryId?: string;
}

export interface SessionEntries {
  entries: SessionEntry[];
  leafEntryId?: string;
}

/** A durable append-only session record. `kind` guarantees a minimum vocabulary of
 *  "user" | "assistant" | "tool"; engine-specific kinds beyond it MUST be skippable. */
export interface SessionEntry {
  id: string;
  parentId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}

// ── Live events (observation plane) ──────────────────────────────────────────

/** Semantic-only: no sequence, no epoch, no session id — in-process the stream is lossless and
 *  ordered, and those concerns belong to the transport envelope (design §13). Consumers MUST
 *  forward or ignore unknown event types; the vocabulary is additive. */
export interface SessionEvent<TType extends string = string, TData extends Json = Json> {
  type: TType;
  timestamp: number;
  /** Present on run-scoped events. */
  runId?: string;
  data: TData;
}

export type RunStartedEvent = SessionEvent<"run_started", Record<never, never>> & { runId: string };
export type RunSettledEvent = SessionEvent<
  "run_settled",
  {
    status: "completed" | "failed" | "aborted";
    error?: { code?: string; message: string; retryable: boolean };
  }
> & { runId: string };
// message_*/tool_* events only exist inside a run, so their types REQUIRE `runId` — a consumer of
// KnownSessionEvent must not null-check a field the contract guarantees.
export type MessageStartedEvent = SessionEvent<"message_started", Record<never, never>> & { runId: string };
export type MessageDeltaEvent = SessionEvent<"message_delta", { channel: "text" | "thinking"; delta: string }> & {
  runId: string;
};
export type MessageFinishedEvent = SessionEvent<"message_finished", Record<never, never>> & { runId: string };
export type ToolStartedEvent = SessionEvent<"tool_started", { id: string; name: string; args: Json }> & {
  runId: string;
};
/** Replace semantics: `partialResult` is the accumulated snapshot so far, not a delta. */
export type ToolProgressEvent = SessionEvent<"tool_progress", { id: string; name: string; partialResult: Json }> & {
  runId: string;
};
export type ToolFinishedEvent = SessionEvent<"tool_finished", { id: string; isError: boolean; content: Json }> & {
  runId: string;
};
/** Normalized live queue depths for the active run (L1). */
export type QueueChangedEvent = SessionEvent<"queue_changed", { steering: number; followUp: number }> & {
  runId: string;
};

/**
 * The serving process failed outside a normal run outcome (fail visibly). Emitted by TRANSPORT
 * adapters (design §13) when they lose the backend before ending a remote stream — an in-process
 * embedding cannot produce it (a dead process has no one left to emit), so it is deliberately NOT
 * part of {@link KnownSessionEvent}: a local L0 client would be handling a signal that cannot occur.
 */
export type ServingErrorEvent = SessionEvent<"serving_error", { message: string }>;

/** Every event the in-process observation plane emits today: the L0 vocabulary plus L1
 *  `queue_changed`. L2 events (turn_*, compaction_*, retry_*, state_changed) arrive with boundary
 *  mutations; {@link ServingErrorEvent} arrives with the transport adapter. */
export type KnownSessionEvent =
  | RunStartedEvent
  | RunSettledEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageFinishedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolFinishedEvent
  | QueueChangedEvent;
