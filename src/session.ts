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
  entries(session: string, options?: { since?: string }): Promise<SessionEntries>;
  events(session: string): AsyncIterable<SessionEvent>;
  dispatch(session: string, command: SessionCommand): Promise<SessionResult>;
}

/** Static support declaration. Clients MUST gate controls on it; unsupported commands are rejected
 *  before acceptance with {@link UNSUPPORTED_CAPABILITY_CODE}. `state`/`entries`/`events` are
 *  mandatory (the reconnect contract) and deliberately absent here. */
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
 * mean rejection BEFORE acceptance — the only case that is safe to blindly retry.
 */
export type SessionResult =
  | { ok: true; runId?: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

// ── State and durable entries (observation plane) ────────────────────────────

export interface SessionState {
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
export type MessageStartedEvent = SessionEvent<"message_started", Record<never, never>>;
export type MessageDeltaEvent = SessionEvent<"message_delta", { channel: "text" | "thinking"; delta: string }>;
export type MessageFinishedEvent = SessionEvent<"message_finished", Record<never, never>>;
export type ToolStartedEvent = SessionEvent<"tool_started", { id: string; name: string; args: Json }>;
/** Replace semantics: `partialResult` is the accumulated snapshot so far, not a delta. */
export type ToolProgressEvent = SessionEvent<"tool_progress", { id: string; name: string; partialResult: Json }>;
export type ToolFinishedEvent = SessionEvent<"tool_finished", { id: string; isError: boolean; content: Json }>;
/** The serving process failed outside a normal run outcome (fail visibly). */
export type ServingErrorEvent = SessionEvent<"serving_error", { message: string }>;

/** The Phase 1 (L0) vocabulary. L1–L2 events (queue_changed, turn_*, compaction_*, retry_*,
 *  state_changed) arrive with the control plane. */
export type KnownSessionEvent =
  | RunStartedEvent
  | RunSettledEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageFinishedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolFinishedEvent
  | ServingErrorEvent;
