/**
 * Session control plane — the engine-neutral serving extension beside Agent Handler (docs/design/session-control.md).
 */
import type { Json, Prompt } from "./agent.ts";

// ── Contract ─────────────────────────────────────────────────────────────────

export interface SessionControl {
  capabilities(): SessionCapabilities;
  /** The names this agent exposes — what a composer's `/` completion LISTS. */
  commands(): Promise<AgentCommand[]>;
  sessions: SessionCollection;
}

export interface SessionCollection {
  /**
   * Every session this DEPLOYMENT holds — what a GUI shows as its conversation list, and the only call that is not
   * about ONE session. Deployment-level on purpose: a multi-tenant facade in front of one deployment MUST NOT expose
   * it, because it answers for every user at once. The one read that MAY reject: `[]` is a complete answer for a
   * deployment with no sessions, so it would be a lie for a store that cannot be enumerated. Every other read stays
   * TOTAL.
   */
  list(): Promise<SessionSummary[]>;
  /** Copy `from`'s history up to entry `at` into a session called `into`. */
  fork(options: { from: string; at: string; into: string }): Promise<SessionResult>;
  get(session: string): Session;
}

/**
 * Can this id be ADDRESSED by a client? URL normalisation eats `""`, `.` and `..` before any router sees them, so a
 * request for `.` would answer about the collection instead. The rule lives in the contract because both sides
 * enforce it and must not drift: a transport refuses to send such an id, and an implementation refuses to MINT one.
 */
export function isAddressableSession(session: string): boolean {
  return session !== "" && session !== "." && session !== "..";
}

/** One session, bound. */
export interface Session {
  readonly id: string;
  state(): Promise<SessionState>;
  /**
   * `since` is an APPEND-ORDER position cursor: "every record appended after the one with this id", regardless of
   * branch structure.
   */
  entries(options?: { since?: string }): Promise<SessionEntries>;
  events(): AsyncIterable<SessionEvent>;
  /** Set durable session properties. */
  update(patch: SessionUpdate): Promise<SessionResult>;
  /** Join the active run: delivered after the current turn's tool calls, before the next model call. */
  steer(prompt: Prompt): Promise<SessionResult>;
  /** Queue for the active run, FIFO, delivered when it is otherwise idle. */
  followUp(prompt: Prompt): Promise<SessionResult>;
  /** Stop the active run — its queues, its retry delay, its cancellable tool work. */
  abort(): Promise<SessionResult>;
  /** Summarize the history at a session boundary. */
  compact(options?: { instructions?: string }): Promise<SessionResult>;
  delete(): Promise<SessionResult>;
}

/** The durable properties {@link Session.update} sets. */
export interface SessionUpdate {
  /** The display name `list()` reports — a label, not an identity: the id stays the Caller's. */
  name?: string;
  /** A FastAgent model spec, constrained to {@link SessionCapabilities.allowedModels}. */
  model?: string;
  /**
   * A string because supported levels are MODEL-dependent — the set for this session's current model is {@link
   * SessionState.availableThinkingLevels}.
   */
  thinkingLevel?: string;
  /**
   * Move the session's active leaf: the write verb for the tree `entries()` publishes, and how sibling branches come
   * to exist (the next turn hangs off it).
   */
  leafEntryId?: string;
}

export type SessionUpdateField = keyof SessionUpdate;

/**
 * Every field name, as a value — what an implementation checks a patch against, and what a transport rejects an
 * unknown key by.
 */
export const UPDATE_FIELDS = [
  "name",
  "model",
  "thinkingLevel",
  "leafEntryId",
] as const satisfies readonly SessionUpdateField[];

/** The wire form of the run actions — what a transport carries for {@link Session.steer} and its siblings. */
export type SessionAction =
  | { type: "steer"; prompt: Prompt }
  | { type: "follow_up"; prompt: Prompt }
  | { type: "abort" }
  | { type: "compact"; instructions?: string };

/**
 * STATIC support declaration — sessionless, so nothing here may depend on a session. Two kinds of flag: GATES
 * (`steering`, `followUp`, `compaction`, `fork`, `delete`, `updatable`), which a client MUST check before calling —
 * calling past one rejects with {@link UNSUPPORTED_CAPABILITY_CODE} — and OBSERVATION QUALITY (`toolProgress`,
 * `usage`), which only say whether those events and state fields appear at all.
 */
export interface SessionCapabilities {
  steering: boolean;
  followUp: boolean;
  compaction: boolean;
  fork: boolean;
  delete: boolean;
  /** Which {@link SessionUpdate} fields this deployment accepts. */
  updatable: SessionUpdateField[];
  /** The specs `update({ model })` accepts — present iff `model` is updatable. */
  allowedModels?: string[];
  toolProgress: boolean;
  usage: boolean;
}

/** One name a client can offer the user. */
export interface AgentCommand {
  name: string;
  description?: string;
  source: string;
}

/**
 * Stable `SessionResult.error.code` for a call, or an update field, the implementation does not support — the answer
 * to calling past a {@link SessionCapabilities} gate.
 */
export const UNSUPPORTED_CAPABILITY_CODE = "unsupported_capability";

/**
 * Stable `SessionResult.error.code` for a run action (`steer`/`follow_up`/`abort`) called while the session has no
 * active run.
 */
export const NO_ACTIVE_RUN_CODE = "no_active_run";

/** Stable `SessionResult.error.code` for a PAYLOAD that is invalid for this runtime. */
export const INVALID_COMMAND_CODE = "invalid_command";

/** Stable `SessionResult.error.code` for a write against a session that does not exist. */
export const NO_SUCH_SESSION_CODE = "no_such_session";

/** Stable `SessionResult.error.code` for a write rejected BEFORE acceptance with nothing durable landed. */
export const BOUNDARY_COMMAND_FAILED_CODE = "boundary_command_failed";

/**
 * Stable `SessionResult.error.code` for `compact` on a session with no compactable history yet — a no-op, not a
 * failure, rejected before acceptance.
 */
export const NOTHING_TO_COMPACT_CODE = "nothing_to_compact";

/**
 * Stable `SessionResult.error.code` for a run action that reached an active run but could not take effect because the
 * run raced to settlement (or the engine refused it).
 */
export const RUN_COMMAND_FAILED_CODE = "run_command_failed";

/** What {@link SessionCollection.list} rejects with — the only read that can. `retryable: true`: the condition is
 *  the store's availability, not the request. */
export const SESSIONS_UNAVAILABLE_CODE = "sessions_unavailable";

/**
 * Stable `SessionResult.error.code` for a multi-field {@link Session.update} that wrote some of its fields and then
 * failed.
 */
export const PARTIAL_UPDATE_CODE = "partial_update";

/**
 * Acceptance is not outcome: `ok: true` means admitted or applied, never that the run ultimately succeeded (outcomes
 * are `run_settled` events / the invoke terminal).
 */
export type SessionResult =
  | { ok: true; runId?: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

// ── State and durable entries (observation plane) ────────────────────────────

/** One session in {@link SessionControl.sessions} — a conversation-list row, not a session's contents. */
export interface SessionSummary {
  session: string;
  /** Set by `update({ name })`; absent until then — a client showing a list falls back to `preview`. */
  name?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** First user message, truncated — enough for a list row, not a transcript. */
  preview?: string;
}

export interface SessionState {
  /** Set by `update({ name })`, so a client that opens a session directly gets the same label the list showed. */
  name?: string;
  /** `compacting` refers to MANUAL compaction (`compact`) at a session boundary. */
  status: "idle" | "running" | "compacting";
  activeRunId?: string;
  /** What this session will RUN with, not what was recorded. */
  model?: string;
  thinkingLevel?: string;
  /** What `update({ thinkingLevel })` accepts for THIS session — re-read after a model change. */
  availableThinkingLevels?: string[];
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

/**
 * A durable append-only session record. `kind` guarantees a minimum vocabulary of "user" | "assistant" | "tool";
 * engine-specific kinds beyond it MUST be skippable.
 */
export interface SessionEntry {
  id: string;
  parentId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}

// ── Live events (observation plane) ──────────────────────────────────────────

/**
 * Semantic-only: no sequence, no epoch, no session id — in-process the stream is lossless and ordered, and those
 * concerns belong to the transport envelope (design §13). Consumers MUST forward or ignore unknown event types; the
 * vocabulary is additive.
 */
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
// message_*/tool_* events only exist inside a run, so their types REQUIRE `runId` — a consumer of KnownSessionEvent
// must not null-check a field the contract guarantees.
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

/** An {@link Session.update} changed durable session state (L2; no runId — a property is set between runs). */
export type StateChangedEvent = SessionEvent<
  "state_changed",
  { name?: string; model?: string; thinkingLevel?: string; leafEntryId?: string }
>;

/** Manual compaction bounds (L2): every `compaction_started` is closed by exactly one `compaction_finished`. */
export type CompactionStartedEvent = SessionEvent<"compaction_started", Record<never, never>>;
export type CompactionFinishedEvent = SessionEvent<
  "compaction_finished",
  { summary?: string; error?: string; aborted?: boolean }
>;

/**
 * A transient provider failure scheduled a summarization retry backoff (auto-compaction / branch summaries inside a
 * run — `runId` present — or a manual `compact` at a boundary — no `runId`).
 */
export type RetryScheduledEvent = SessionEvent<
  "retry_scheduled",
  {
    /**
     * "assistant" is an engine that retries the ANSWER request itself (pi's AgentSession does; pi's own session does;
     * a summarization call is the other two).
     */
    operation: "assistant" | "compaction" | "branch_summary";
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: string;
  }
>;

/** The serving process failed outside a normal run outcome (fail visibly). */
export type ServingErrorEvent = SessionEvent<"serving_error", { message: string }>;

/**
 * Every event the in-process observation plane emits today: L0, L1 `queue_changed`, and the L2 events
 * (`state_changed`, `compaction_*`, `retry_scheduled`).
 */
export type KnownSessionEvent =
  | RunStartedEvent
  | RunSettledEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageFinishedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolFinishedEvent
  | QueueChangedEvent
  | StateChangedEvent
  | CompactionStartedEvent
  | CompactionFinishedEvent
  | RetryScheduledEvent;
