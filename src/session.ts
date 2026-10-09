/**
 * Session control plane — the harness-neutral serving extension beside Agent Handler
 * (docs/design/session-control.md).
 */
import type { ImageRef, Json, Prompt } from "./agent.ts";

// ── Contract ─────────────────────────────────────────────────────────────────

export interface SessionControl {
  /** What this deployment supports. Fixed for its life, so a client may read it once. */
  capabilities(): SessionCapabilities;
  /** The names this agent exposes — what a composer's `/` completion LISTS. */
  commands(): Promise<AgentCommand[]>;
  /**
   * The models `update({ model })` accepts now, by `spec`; empty where `model` is not updatable. Asked per call, like
   * {@link commands}: the definition can change them while it runs (an extension that declares a model). Rejects when
   * the registry cannot be built now (`extensions/` cannot be read): `[]` would say `model` is not updatable.
   */
  models(): Promise<ModelDescriptor[]>;
  sessions: SessionCollection;
}

export interface SessionCollection {
  /**
   * Every session this DEPLOYMENT holds — what a GUI shows as its conversation list, and the only call that is not
   * about ONE session. Deployment-level on purpose: a multi-tenant facade in front of one deployment MUST NOT expose
   * it, because it answers for every user at once. It MAY reject: `[]` is a complete answer for a deployment with no
   * sessions, so it would be a lie for a store that cannot be enumerated. A session's own reads stay TOTAL.
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
  /**
   * The bytes behind an {@link EntryImage.ref} this session published; `undefined` when this session holds no such
   * image. Total, like every read but `list()`.
   *
   * Over the wire, a `mimeType` other than `image/png`, `image/jpeg`, `image/gif` or `image/webp` reads back as
   * `application/octet-stream`: the transport will not serve a sender-declared type it cannot trust (the entry still
   * lists the declared one). pi normalizes an invoke's opening prompt images to those four; a `steer`/`followUp`
   * image and a tool result keep whatever type the sender declared, so `image/jpg`, a type with parameters, or
   * `image/svg+xml` sent that way reads back as `application/octet-stream` remotely.
   */
  image(ref: string): Promise<ImageRef | undefined>;
  events(): SessionEventStream;
  /**
   * Set durable session properties, applied by the session's next turn. An id with no record (nothing has written it
   * yet) takes them too: the write creates its record, and the session's first turn runs on them. Refused there:
   * `leafEntryId` (no entries to point at) and an id no client could address ({@link isAddressableSession}).
   */
  update(patch: SessionUpdate): Promise<SessionResult>;
  /**
   * Join the active run: delivered after the current turn's tool calls, before the next model call. `prompt.text`
   * must not be empty (`invalid_command`): a queued prompt is reported by its text ({@link PendingPrompts}). An
   * accepted result carries its {@link PromptDisposition}.
   */
  steer(prompt: Prompt): Promise<SessionResult>;
  /**
   * Queue for the active run, FIFO, delivered when it is otherwise idle. Same non-empty `text` rule and
   * {@link PromptDisposition} as `steer`.
   */
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
  /** A FastAgent model spec, constrained to what {@link SessionControl.models} lists. */
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
  /** Which {@link SessionUpdate} fields this deployment accepts; `models()` lists the models `model` takes. */
  updatable: SessionUpdateField[];
  toolProgress: boolean;
  usage: boolean;
}

/**
 * A model as a picker shows it, before any session runs on it. `thinkingLevels` is what `update({ thinkingLevel })`
 * accepts for a session on this model; `name` and `contextWindow` are absent when the model does not declare them.
 */
export interface ModelDescriptor {
  /** What `update({ model })` takes. */
  spec: string;
  name?: string;
  thinkingLevels: string[];
  contextWindow?: number;
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

/**
 * Stable `SessionResult.error.code` for a write that needs a record (fork's source, compact, delete) against an id
 * that has none, because nothing has written it yet. `update()` creates the record instead, and answers this code only
 * when a concurrent `delete()` removes the record between its read and its write.
 */
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
 * run raced to settlement (or the harness refused it).
 */
export const RUN_COMMAND_FAILED_CODE = "run_command_failed";

/** What {@link SessionCollection.list} rejects with — the only read that can. `retryable: true`: the condition is
 *  the store's availability, not the request. */
export const SESSIONS_UNAVAILABLE_CODE = "sessions_unavailable";

/**
 * Stable `SessionResult.error.code` for a multi-field {@link Session.update} that wrote some of its fields and then
 * failed — the ONE code that reports durable work behind an `ok: false`. The message names what landed, and a
 * `state_changed` event reporting the record as it now is precedes it.
 */
export const PARTIAL_UPDATE_CODE = "partial_update";

/**
 * Acceptance is not outcome: `ok: true` means admitted or applied, never that the run ultimately succeeded (outcomes
 * are `run_settled` events / the invoke terminal).
 *
 * `ok: false` means the command did not COMPLETE, which is not the same as "nothing happened". Every code except
 * {@link PARTIAL_UPDATE_CODE} is a rejection before acceptance with nothing durable landed; that one reports fields
 * that did land, because properties are separate journal entries and no harness here can roll them back. So the
 * question "may I send this again" is answered by `retryable`, never by `ok` — a client that blindly re-sends every
 * `ok: false` re-applies what a partial update already wrote.
 */
export type SessionResult =
  | { ok: true; runId?: string; disposition?: PromptDisposition }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

/**
 * What became of an accepted `steer`/`followUp` prompt — present on exactly those results. `queued`: it waits in
 * {@link PendingPrompts} until the run takes it in. `handled`: the harness consumed it before the queue (in pi, a
 * definition extension's `input` handler), so it never enters the conversation, and no `queue_changed` or
 * `user_message` reports it.
 */
export type PromptDisposition = "queued" | "handled";

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
  /**
   * What this session will RUN with, not what was recorded. An id with no record reports what its first turn would run
   * on: the defaults, the level clamped to the model.
   */
  model?: string;
  thinkingLevel?: string;
  /** What `update({ thinkingLevel })` accepts for THIS session — re-read after a model change. */
  availableThinkingLevels?: string[];
  pending: PendingPrompts;
  /**
   * The NEWEST ANSWER's own numbers, not a running total: tokens and `cost` as the provider reported them for the
   * latest answer on the active path that carries usage (an aborted or failed answer does not, so it reports the one
   * before). `contextTokens` is how full the context is now, ABSENT when unknown (after a compaction or a context
   * edit, until the next answer); `contextWindow` is the running model's.
   */
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
 * harness-specific kinds beyond it MUST be skippable.
 */
export interface SessionEntry {
  id: string;
  parentId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}

/**
 * One image a message carried, as `data.images` lists it on a `user` or `tool` entry and on `user_message` (absent
 * when there are none). Bytes stay out: `entries()` is read on every open and reconnect, and one screenshot is
 * megabytes. `ref` is opaque; {@link Session.image} of the same session reads the bytes.
 */
export type EntryImage = { ref: string; mimeType: string };

// ── Live events (observation plane) ──────────────────────────────────────────

/**
 * A live event subscription, plus the ONE thing a reconnecting client cannot infer: when it started.
 *
 * Reconnect has to subscribe BEFORE it reads history, or an event landing between the read and the subscription is
 * lost — it is live-only (`state_changed`, `run_settled`), so no cursor brings it back. Subscribing first is not
 * enough on its own, because "the call returned" is not "the subscription exists": in process the registration
 * happens on the first pull, and over HTTP it happens on the server before the response headers. `ready` is that
 * boundary made waitable, so the recipe is subscribe → await ready → backfill, with no timing guess in it.
 *
 * ONE stream IS one subscription, which is what makes `ready` mean anything: readiness belongs to a subscription, so
 * a stream that could start several would be promising the second one something the first established. Iterating the
 * same stream twice is refused for that reason — call `events()` again, and get the readiness that goes with it.
 *
 * `ready` REJECTS when the subscription cannot be established at all: an unreachable endpoint, a refused token, or an
 * iteration cancelled before it registered. A stream nobody iterates never settles, matching the rule that an
 * iterator obtained but never driven is not subscribed.
 */
export interface SessionEventStream extends AsyncIterable<SessionEvent> {
  ready: Promise<void>;
}

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
/**
 * A user message entered the conversation: the run's opening prompt, a steer or follow-up leaving `pending`, or one an
 * extension sent. It reports after the message is recorded, so `entries()` already holds `entryId` with the same
 * `text` (a slash command expanded) and `images`, and before the answer to it starts. The one live event a backfill
 * can be deduplicated against exactly.
 */
export type UserMessageEvent = SessionEvent<
  "user_message",
  { entryId: string; text: string; images?: EntryImage[] }
> & { runId: string };
/**
 * A piece of the answer being written. The `thinking` deltas of one answer add up to its `assistant` entry's
 * `thinking`, as its `text` deltas add up to its `text`; redacted reasoning is streamed in neither.
 */
export type MessageDeltaEvent = SessionEvent<"message_delta", { channel: "text" | "thinking"; delta: string }> & {
  runId: string;
};
/**
 * How an answer ended, when it did not end normally: absent on an answer that did. One value, carried live by its
 * `message_finished` and durably by its `assistant` entry, so a reopened conversation reads what a watcher saw.
 * `truncated` is an answer cut off at the output limit — a property of the answer, not of its run, which may still
 * complete. An answer whose entry a `context_edit { omitted }` targets (`failed` or `truncated`) is an attempt the
 * harness abandoned; a retry usually, but not always, follows it.
 */
export type AnswerOutcome = { status: "failed" | "aborted" | "truncated"; error?: { message: string } };
export type MessageFinishedEvent = SessionEvent<"message_finished", { outcome?: AnswerOutcome }> & { runId: string };
export type ToolStartedEvent = SessionEvent<
  "tool_started",
  { id: string; name: string; args: Json; parentToolCallId?: string }
> & {
  runId: string;
};
/** Replace semantics: `partialResult` is the accumulated snapshot so far, not a delta. */
export type ToolProgressEvent = SessionEvent<
  "tool_progress",
  { id: string; name: string; partialResult: Json; parentToolCallId?: string }
> & {
  runId: string;
};
/**
 * `terminate: true` when the call asked to end its run. Once every call answering one assistant message asks it, the
 * model is not called again for them, and the run ends there with no answer after its `tool` entries (which carry the
 * same flag) unless a queued steer or follow-up continues it. Whether the run ended is `run_settled`'s to say.
 */
export type ToolFinishedEvent = SessionEvent<
  "tool_finished",
  { id: string; isError: boolean; content: Json; parentToolCallId?: string; terminate?: true }
> & {
  runId: string;
};
/**
 * The prompts queued on the active run, oldest first, as the harness queued them: plain text as sent, a slash command
 * already expanded (a `/skill:…` becomes the skill's text), without its images (its `user_message` carries them). A
 * prompt LEAVES its list when it enters the conversation as a user message: from then on it is in the record and in
 * every later model call (an abort can still end the run before the model answers it). Whatever is still listed when
 * the run settles never entered the conversation and is dropped with the run.
 */
export type PendingPrompts = { steering: string[]; followUp: string[] };

/** The active run's queue changed (L1); `data` is the whole queue, not a delta. */
export type QueueChangedEvent = SessionEvent<"queue_changed", PendingPrompts> & {
  runId: string;
};

/**
 * Durable session state changed (L2; no runId). An {@link Session.update} reports what it landed; where
 * `capabilities().usage` holds, a finished run or compaction reports the session's `usage` as it now reads, and an
 * update that moved `leafEntryId` or changed `model` carries it too (absent there: the session now has none).
 */
export type StateChangedEvent = SessionEvent<
  "state_changed",
  { name?: string; model?: string; thinkingLevel?: string; leafEntryId?: string; usage?: SessionState["usage"] }
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
     * "assistant" is a harness that retries the ANSWER request itself (pi's AgentSession does; pi's own session does;
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
  | UserMessageEvent
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
