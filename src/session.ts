/**
 * Session control plane — the engine-neutral serving extension beside Agent Handler
 * (docs/design/session-control.md). Pure types, zero dependencies; importing any engine
 * implementation here is forbidden, exactly like agent.ts.
 *
 * The plane model: `invoke` is the only data plane (no run exists without an invoke); a session's
 * ACTIONS modulate the run an invoke drives; `state`/`entries`/`events` observe, strictly read-only.
 *
 * The shape follows the question each call answers, not the transport that carries it. A session's
 * PROPERTIES (name, model, thinking level, where its leaf points) are updated; things that HAPPEN to
 * a run (steer, abort, compact) are actions; the set of sessions is a collection. Folding all three
 * into one `dispatch(session, command)` — which is what this once was — made a client spell the
 * session id on every call and read `{ type: "delete" }` as something dispatched INTO a session that
 * is about to stop existing.
 */
import type { Json, Prompt } from "./agent.ts";

// ── Contract ─────────────────────────────────────────────────────────────────

export interface SessionControl {
  capabilities(): SessionCapabilities;
  /** The names this agent exposes — what a composer's `/` completion LISTS. A listing, not an
   *  invocation surface: the data plane takes prompts as text, so what typing one means (expanding
   *  it, sending "use the X skill", filtering a menu) is the client's business. Sessionless (the
   *  definition is a deployment fact) but ASYNC, because a definition is allowed to be live: an
   *  implementation that re-reads it per turn must answer from that same read, or the list and the
   *  behavior diverge. `[]` is a complete answer, not a missing one; a definition the implementation
   *  cannot read at all is a deployment fault and MAY reject. */
  commands(): Promise<AgentCommand[]>;
  sessions: SessionCollection;
}

/** The deployment's sessions, as a collection. */
export interface SessionCollection {
  /** Every session this DEPLOYMENT holds — what a GUI shows as its conversation list, and the only
   *  call that is not about ONE session. Deployment-level on purpose: a multi-tenant facade in front
   *  of one deployment MUST NOT expose it, because it answers for every user at once. Such a facade
   *  does not need it either — `Scope.session` is the Caller's own string, so it already holds the
   *  mapping this would return (design §5).
   *
   *  The one read that MAY reject: `[]` is a complete answer for a deployment with no sessions, so
   *  it would be a lie for a store that cannot be enumerated. Every other read stays TOTAL — their
   *  absent fields are answers a control-less deployment gives too. */
  list(): Promise<SessionSummary[]>;
  /**
   * Copy `from`'s history up to entry `at` into a session called `into` — the growth verb beside
   * {@link SessionUpdate.leafEntryId}'s walk, and the two together are what make a session tree
   * usable. Cloning is this with the source's own `leafEntryId`.
   *
   * IDEMPOTENT: `into` is the CALLER's id (the plane never invents one), so repeating a fork that
   * already landed is `ok: true` and writes nothing — a client that retries a request whose response
   * it never saw does not get a second record. `into` naming a session that exists but came from
   * somewhere else rejects `invalid_command`: same id, different history is what the id would then
   * be lying about.
   *
   * Answers a result, not the new session: the caller minted `into` and can {@link get} it.
   */
  fork(options: { from: string; at: string; into: string }): Promise<SessionResult>;
  /** Bind an id. A PURE BINDING — an id plus the transport it travels on: no state, no lifecycle,
   *  nothing to dispose, and it does not check that the session exists (the calls on it answer that,
   *  each in its own vocabulary). Two handles for one id are interchangeable. */
  get(session: string): Session;
}

/**
 * One session, bound. Every call here is about THIS session, so the id is spelled once.
 *
 * The split inside it is the one the contract is built on: {@link update} sets PROPERTIES (durable,
 * last-wins, applied by the next turn), while the action methods do things TO A RUN (admitted or
 * rejected now, outcome later on the event stream). {@link SessionResult} says which of the two a
 * given answer is.
 */
export interface Session {
  readonly id: string;
  state(): Promise<SessionState>;
  /** `since` is an APPEND-ORDER position cursor: "every record appended after the one with this
   *  id", regardless of branch structure. Reconstructing the active path in a branched session is
   *  the client's job via `parentId` chains from `leafEntryId`. An unknown cursor falls back to a
   *  full backfill (correct, merely larger). */
  entries(options?: { since?: string }): Promise<SessionEntries>;
  events(): AsyncIterable<SessionEvent>;
  /** Set durable session properties. Last-wins, applied by every later turn; an empty patch is a
   *  no-op that still answers `ok: true`. Fields outside {@link SessionCapabilities.updatable}
   *  reject `unsupported_capability`; invalid values reject `invalid_command`, before anything
   *  durable lands. Takes the same lease as a run (`session_busy` while one is in flight). */
  update(patch: SessionUpdate): Promise<SessionResult>;
  /** Join the active run: delivered after the current turn's tool calls, before the next model
   *  call. Not polyfillable — its delivery point is an engine primitive. */
  steer(prompt: Prompt): Promise<SessionResult>;
  /** Queue for the active run, FIFO, delivered when it is otherwise idle. */
  followUp(prompt: Prompt): Promise<SessionResult>;
  /** Stop the active run — its queues, its retry delay, its cancellable tool work — or an in-flight
   *  {@link compact}, which is the same kind of thing: a model call a client must be able to stop. */
  abort(): Promise<SessionResult>;
  /** Summarize the history at a session boundary. ACCEPT-FAST: a full model call, so `ok: true`
   *  means admitted and the outcome travels as `compaction_finished{summary|error|aborted}`. */
  compact(options?: { instructions?: string }): Promise<SessionResult>;
  /** Destroy the record. The plane's only IRREVERSIBLE call, guarded by the same bearer token as
   *  everything else — the only key the framework owns (design §14). Live {@link events} streams for
   *  this session END; a later {@link state} answers for a session that no longer exists. */
  delete(): Promise<SessionResult>;
}

/** The durable properties {@link Session.update} sets. Every field is optional and last-wins; which
 *  ones a deployment accepts is {@link SessionCapabilities.updatable}. */
export interface SessionUpdate {
  /** The display name `list()` reports — a label, not an identity: the id stays the Caller's. */
  name?: string;
  /** A FastAgent model spec, constrained to {@link SessionCapabilities.allowedModels}. Never a
   *  provider credential. */
  model?: string;
  /** A string because supported levels are MODEL-dependent — the set for this session's current
   *  model is {@link SessionState.availableThinkingLevels}. */
  thinkingLevel?: string;
  /** Move the session's active leaf: the write verb for the tree `entries()` publishes, and how
   *  sibling branches come to exist (the next turn hangs off it). Every entry `entries()` publishes
   *  is a legal target; anything else rejects `invalid_command`. A move to where the leaf already is
   *  writes nothing. There is no move to the ROOT — "start from nothing" is a new session, not an
   *  emptied one. */
  leafEntryId?: string;
}

/** What {@link Session.update} can be asked to set. */
export type SessionUpdateField = keyof SessionUpdate;

/**
 * The wire form of the run actions — what a transport carries for {@link Session.steer} and its
 * siblings. Clients use the METHODS; this exists so a transport has one body shape to parse, and so
 * an implementation can answer an unknown `type` as `invalid_command` rather than crashing.
 */
export type SessionAction =
  | { type: "steer"; prompt: Prompt }
  | { type: "follow_up"; prompt: Prompt }
  | { type: "abort" }
  | { type: "compact"; instructions?: string };

/**
 * STATIC support declaration — sessionless, so nothing here may depend on a session. Two kinds of
 * flag, and the difference decides what a client does with them:
 * - GATES (`steering`, `followUp`, `compaction`, `fork`, `delete`, `updatable`): a client MUST gate
 *   its controls on these; calling past one rejects before acceptance with
 *   {@link UNSUPPORTED_CAPABILITY_CODE}.
 * - OBSERVATION QUALITY (`toolProgress`, `usage`): whether those events/state fields appear at all —
 *   nothing to call, nothing to reject.
 *
 * `allowedModels` may live here because the registry is a deployment fact; thinking LEVELS depend on
 * the model a session is currently running, so they live on
 * {@link SessionState.availableThinkingLevels} — a static list could only answer for one model.
 *
 * `state`/`entries`/`events` and `sessions.list()` are mandatory (the reconnect contract and the
 * conversation list) and deliberately absent here.
 */
export interface SessionCapabilities {
  steering: boolean;
  followUp: boolean;
  compaction: boolean;
  fork: boolean;
  delete: boolean;
  /** Which {@link SessionUpdate} fields this deployment accepts. A patch naming anything else
   *  rejects `unsupported_capability` — a LIST rather than a flag per field, so a client reads the
   *  same names it writes. */
  updatable: SessionUpdateField[];
  /** The specs `update({ model })` accepts — present iff `model` is updatable. */
  allowedModels?: string[];
  toolProgress: boolean;
  usage: boolean;
}

/**
 * One name a client can offer the user. Field NAMES follow pi's RPC `get_commands` so a client
 * porting from it maps directly; its `sourceInfo` (file provenance) is deliberately not carried, and
 * `source` is a free-form string rather than pi's closed union — which kinds exist is an engine's
 * business ("skill" is the only one fastagent assembles today), and an engine with none answers `[]`
 * rather than the contract enumerating a set it cannot know.
 */
export interface AgentCommand {
  name: string;
  description?: string;
  source: string;
}

/** Stable `SessionResult.error.code` for a call, or an update field, the implementation does not
 *  support — the answer to calling past a {@link SessionCapabilities} gate. */
export const UNSUPPORTED_CAPABILITY_CODE = "unsupported_capability";

/** Stable `SessionResult.error.code` for a run action
 *  (`steer`/`follow_up`/`abort`) called while the session has no active run — and, for `abort`, no
 *  in-flight compaction either (`abort` is also the door out of a `compacting` state; the outcome
 *  then travels as `compaction_finished{aborted}`). `retryable: false` — the same call fails again;
 *  call it after `state()` shows an active run. */
export const NO_ACTIVE_RUN_CODE = "no_active_run";

/** Stable `SessionResult.error.code` for a PAYLOAD that is invalid for this runtime — an unknown
 *  model spec, an unsupported thinking level, an entry id that is not a position, a fork onto an id
 *  another history already holds. Permanent for that payload; a different value may succeed.
 *  Rejected before acceptance. */
export const INVALID_COMMAND_CODE = "invalid_command";

/** Stable `SessionResult.error.code` for a write against a session that does not exist. Sessions are
 *  created by the DATA plane (`invoke`) or copied by `fork`, never minted by an update — a write on
 *  an unknown id (a typo, a not-yet-started conversation) must not create a ghost record. Rejected
 *  before acceptance; retry once the session's first turn exists. */
export const NO_SUCH_SESSION_CODE = "no_such_session";

/** Stable `SessionResult.error.code` for a write rejected BEFORE acceptance with nothing durable
 *  landed — a failed property append, a fork whose copy could not be written, or compact's admission
 *  failing (binding the session, the local preparation). Acceptance sits where the work becomes asynchronous and
 *  expensive: the model call — compact is accept-fast (holding the dispatch open for a full model
 *  call would make acceptance = outcome), and post-acceptance outcomes travel as
 *  `compaction_finished{summary|error|aborted}` events. `retryable: true` throughout: the same
 *  command may succeed on retry (the state-dependent "nothing to compact" has its own code,
 *  {@link NOTHING_TO_COMPACT_CODE}). */
export const BOUNDARY_COMMAND_FAILED_CODE = "boundary_command_failed";

/** Stable `SessionResult.error.code` for `compact` on a session with no compactable history yet —
 *  a no-op, not a failure, rejected before acceptance. The {@link NO_ACTIVE_RUN_CODE} pattern:
 *  `retryable: false` (as-is retry fails now), call it again once the session has grown. */
export const NOTHING_TO_COMPACT_CODE = "nothing_to_compact";

/** Stable `SessionResult.error.code` for a run action that reached an active run but could not take
 *  effect because the run raced to settlement (or the engine refused it). Distinct from
 *  {@link NO_ACTIVE_RUN_CODE}: the run existed — and TRANSIENT: the session's next run can be acted
 *  on. Still pre-acceptance — nothing was queued — and `retryable: false`: the same call fails
 *  again. (A run registered without modulation controls is a capability problem, not a run problem,
 *  and rejects with {@link UNSUPPORTED_CAPABILITY_CODE}.) */
export const RUN_COMMAND_FAILED_CODE = "run_command_failed";

/** Stable error code for the ONE read that may fail: {@link SessionCollection.list} against a store
 *  it cannot enumerate. It does not ride a `SessionResult` — `sessions()` rejects, and a transport
 *  carries this code in the error body of a non-2xx (design §13). `retryable: true`: the condition is
 *  the store's availability, not the request. Every OTHER read stays total, so this is the whole of
 *  the read failure vocabulary. */
export const SESSIONS_UNAVAILABLE_CODE = "sessions_unavailable";

/**
 * Acceptance is not outcome: `ok: true` means admitted or applied, never that the run ultimately
 * succeeded (outcomes are `run_settled` events / the invoke terminal). `ok: false` is guaranteed to
 * mean rejection BEFORE acceptance — nothing was queued or applied. ONE exception to "nothing took
 * effect": a rejected `abort` may still have attributed a concurrently-settling run as `aborted`
 * (the intent was live while the run resolved — see the guarantee boundary in the pi
 * implementation); the settlement is the truth. `error.retryable` means "the SAME call as-is may
 * succeed"; a `false` with a state-dependent code (e.g. {@link NO_ACTIVE_RUN_CODE}) invites another
 * call only after `state()` shows the condition changed.
 */
export type SessionResult =
  | { ok: true; runId?: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

// ── State and durable entries (observation plane) ────────────────────────────

/** One session in {@link SessionControl.sessions} — a conversation-list row, not a session's
 *  contents. `session` is the CALLER's id (the string a channel minted), never a storage name. */
export interface SessionSummary {
  session: string;
  /** Set by `set_name`; absent until then — a client showing a list falls back to `preview`. */
  name?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** First user message, truncated — enough for a list row, not a transcript. */
  preview?: string;
}

export interface SessionState {
  /** Set by `set_name`, so a client that opens a session directly gets the same label the list
   *  showed. */
  name?: string;
  /** `compacting` refers to Phase 2 MANUAL compaction at a session boundary. Automatic overflow
   *  compaction happens inside a run's activity window and reports as `running`. */
  status: "idle" | "running" | "compacting";
  activeRunId?: string;
  /** What this session will RUN with, not what was recorded: overrides resolved against the
   *  deployment (a model the registry lost falls back to the configured one; a level the current
   *  model cannot do is clamped). Absent where the implementation exposes no model control. */
  model?: string;
  thinkingLevel?: string;
  /** What `set_thinking` accepts for THIS session — re-read after a `set_model`. */
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

/** A boundary mutation changed durable session state (L2; no runId — boundary mutations happen
 *  between runs). `leafEntryId` reports a `navigate` — a deliberate move of the branch head, which
 *  a second attached client would otherwise have no signal for. It is NOT a general leaf feed:
 *  every turn advances the leaf too, and that is read from `entries()`/`state()` after the run. */
export type StateChangedEvent = SessionEvent<
  "state_changed",
  { model?: string; thinkingLevel?: string; leafEntryId?: string }
>;

/** Manual compaction bounds (L2): every `compaction_started` is closed by exactly one
 *  `compaction_finished` — `summary` on success, `error` on failure, `aborted: true` on a
 *  deliberate stop (run/compaction symmetry with `run_settled{status: "aborted"}`: a client's own
 *  abort is not a failure). In the failure and aborted cases nothing durable landed. Automatic
 *  overflow compaction stays inside its run's activity window and does not emit these. */
export type CompactionStartedEvent = SessionEvent<"compaction_started", Record<never, never>>;
export type CompactionFinishedEvent = SessionEvent<
  "compaction_finished",
  { summary?: string; error?: string; aborted?: boolean }
>;

/** A transient provider failure scheduled a summarization retry backoff (auto-compaction /
 *  branch summaries inside a run — `runId` present — or a manual `compact` at a boundary — no
 *  `runId`). Explains a quiet gap that would otherwise read as a hang. Deliberately unclosed:
 *  the next event (message_*, `run_settled`, `compaction_finished`) is the closure, and the
 *  engine's `retry_finished` carries no outcome to forward. */
export type RetryScheduledEvent = SessionEvent<
  "retry_scheduled",
  {
    /** "assistant" is an engine that retries the ANSWER request itself (pi's AgentSession does;
     *  pi's own session does; a summarization call is the other two). */
    operation: "assistant" | "compaction" | "branch_summary";
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: string;
  }
>;

/**
 * The serving process failed outside a normal run outcome (fail visibly). Emitted by TRANSPORT
 * adapters (design §13) when they lose the backend before ending a remote stream — an in-process
 * embedding cannot produce it (a dead process has no one left to emit), so it is deliberately NOT
 * part of {@link KnownSessionEvent}: a local L0 client would be handling a signal that cannot occur.
 */
export type ServingErrorEvent = SessionEvent<"serving_error", { message: string }>;

/** Every event the in-process observation plane emits today: L0, L1 `queue_changed`, and the L2
 *  events (`state_changed`, `compaction_*`, `retry_scheduled`). Remaining L2 events (turn_*) are
 *  future vocabulary; {@link ServingErrorEvent} arrives with the transport adapter. */
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
