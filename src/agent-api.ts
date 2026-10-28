/**
 * The Agent API (docs/design/agent-api.md) as Effect Schemas: its objects, what a Caller sends, its errors and its
 * limits. Imports only `effect`: it is the layer that keeps the harness away from its Callers, and the HTTP binding is
 * built from the same schemas, so the two bindings cannot describe different APIs.
 */
import * as Schema from "effect/Schema";

export type Json = Schema.Json;

export const ModelRef = Schema.Struct({ provider: Schema.String, modelId: Schema.String });
export type ModelRef = typeof ModelRef.Type;

export const ThinkingLevel = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = typeof ThinkingLevel.Type;

export class Tokens extends Schema.Opaque<Tokens>()(
  Schema.Struct({
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    cacheReadTokens: Schema.optionalKey(Schema.Number),
    cacheWriteTokens: Schema.optionalKey(Schema.Number),
    cost: Schema.optionalKey(Schema.Number),
  }),
) {}

/** Spend by `provider/model` for model calls, and by tool name for what tools reported (§3). */
export class Usage extends Schema.Opaque<Usage>()(
  Schema.Struct({
    models: Schema.Record(Schema.String, Tokens),
    tools: Schema.Record(Schema.String, Tokens),
  }),
) {}

const Named = Schema.Struct({ name: Schema.String, description: Schema.optionalKey(Schema.String) });

export class AgentInfo extends Schema.Opaque<AgentInfo>()(
  Schema.Struct({
    name: Schema.String,
    description: Schema.optionalKey(Schema.String),
    /** What a message may start with as `/<name>` (§5.1). */
    commands: Schema.Array(Named),
    /** The tools a session may enable. */
    tools: Schema.Array(Named),
    /** The models a session may name: those whose provider has a credential here. */
    models: Schema.Array(
      Schema.Struct({ provider: Schema.String, modelId: Schema.String, name: Schema.optionalKey(Schema.String) }),
    ),
    defaultModel: Schema.optionalKey(ModelRef),
  }),
) {}

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
/** An image in a message carries its bytes, base64. */
const ImagePart = Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String });
/** An image in an entry is a ref, read with `sessions.attachment`. */
const ImageRef = Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, ref: Schema.String });
export const ContentPart = Schema.Union([TextPart, ImagePart, ImageRef]);
export type ContentPart = typeof ContentPart.Type;

/** The shape of an error as data: in a failed message, and in a `stream_error`. */
export const AgentErrorData = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  /** Whether the same request may succeed if sent again. */
  retryable: Schema.Boolean,
  details: Schema.optionalKey(Schema.Json),
});
export type AgentErrorData = typeof AgentErrorData.Type;

/** What every operation rejects with (§7). */
export class AgentError extends Schema.Error<AgentError>("AgentError")(AgentErrorData) {}

/**
 * A session's settings. An object the Agent answers with leaves out what it does not name (`optionalKey`); what a Caller
 * sends may also give a field as `undefined`, which is the same as leaving it out (`optional`), as a TypeScript Caller
 * without `exactOptionalPropertyTypes` writes it.
 */
const settingsFields = <O extends typeof Schema.optionalKey | typeof Schema.optional>(optional: O) => ({
  model: optional(ModelRef),
  thinkingLevel: optional(ThinkingLevel),
  /** Text added at the end of the agent's system prompt for this session. */
  instructions: optional(Schema.String),
  /** The tools the session enables, each among `info().tools`. */
  tools: optional(Schema.Array(Schema.String)),
});

export class Session extends Schema.Opaque<Session>()(
  Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(["idle", "running"]),
    ...settingsFields(Schema.optionalKey),
    /** The agent's reply being written, as written so far: present only while one is. */
    reply: Schema.optionalKey(Schema.Struct({ text: Schema.String, thinking: Schema.optionalKey(Schema.String) })),
    usage: Usage,
  }),
) {}

/** A message's statuses: `queued` and `running` until it ends, then one of the four ends, which are all its ends. */
export const MessageStatus = Schema.Literals(["queued", "running", "completed", "incomplete", "failed", "canceled"]);
export type MessageStatus = typeof MessageStatus.Type;

export class Message extends Schema.Opaque<Message>()(
  Schema.Struct({
    id: Schema.String,
    sessionId: Schema.String,
    idempotencyKey: Schema.optionalKey(Schema.String),
    status: MessageStatus,
    /** Its `user` entry, once the agent took it. */
    entryId: Schema.optionalKey(Schema.String),
    /** The `assistant` entry the agent stopped on for it: when `completed`, and when `incomplete`. */
    answer: Schema.optionalKey(Schema.Struct({ entryId: Schema.String, text: Schema.String })),
    /** Why it `failed`. */
    error: Schema.optionalKey(AgentErrorData),
  }),
) {}

const ENDS: ReadonlySet<string> = new Set<MessageStatus>(["completed", "incomplete", "failed", "canceled"]);

/** Whether a message has ended: its ends are a closed set, so any other status, known or not, has not (§7.1). */
export const hasEnded = (message: Pick<Message, "status">): boolean => ENDS.has(message.status);

/**
 * One durable record of a session's history. Its `data` by `kind`:
 * - `user`: `{ content: ContentPart[], messageId? }`
 * - `assistant`: `{ text, thinking?, toolCalls?: { id, name, args }[], stop?: "max_tokens" | "failed" | "aborted",
 *   error?, usage }`
 * - `tool_result`: `{ toolCallId, toolName, isError, content: ContentPart[] }`
 * - `compaction`: `{ summary }`
 */
export class Entry extends Schema.Opaque<Entry>()(
  Schema.Struct({ id: Schema.String, timestamp: Schema.Number, kind: Schema.String, data: Schema.Json }),
) {}

export interface Page<T> {
  data: T[];
  next?: string;
  prev?: string;
}

export const SessionEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("entry"), entry: Entry }),
  Schema.Struct({ type: Schema.Literal("state"), session: Session }),
  Schema.Struct({ type: Schema.Literal("delta"), channel: Schema.Literals(["text", "thinking"]), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_started"),
    toolCallId: Schema.String,
    name: Schema.String,
    args: Schema.Json,
  }),
  Schema.Struct({ type: Schema.Literal("tool_progress"), toolCallId: Schema.String, text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("retrying"),
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    delayMs: Schema.Number,
    reason: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("done"), message: Message }),
  Schema.Struct({ type: Schema.Literal("stream_error"), error: AgentErrorData }),
]);
export type SessionEvent = typeof SessionEvent.Type;

export const MessageStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message"), message: Message }),
  ...SessionEvent.members,
]);
export type MessageStreamEvent = typeof MessageStreamEvent.Type;

const Limit = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }));
const Seconds = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const SessionSettings = Schema.Struct(settingsFields(Schema.optional));
export type SessionSettings = typeof SessionSettings.Type;

export const CreateSessionOptions = Schema.Struct({
  ...settingsFields(Schema.optional),
  forkFrom: Schema.optional(Schema.Struct({ sessionId: Schema.String, entryId: Schema.optional(Schema.String) })),
});
export type CreateSessionOptions = typeof CreateSessionOptions.Type;

/** `null` clears a field back to the deployment's. */
export const SessionChanges = Schema.Struct({
  model: Schema.optional(Schema.NullOr(ModelRef)),
  thinkingLevel: Schema.optional(Schema.NullOr(ThinkingLevel)),
  instructions: Schema.optional(Schema.NullOr(Schema.String)),
  tools: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
export type SessionChanges = typeof SessionChanges.Type;

export const ListOptions = Schema.Struct({
  limit: Schema.optional(Limit(500)),
  after: Schema.optional(Schema.String),
});
export type ListOptions = typeof ListOptions.Type;

export const EntriesOptions = Schema.Struct({
  after: Schema.optional(Schema.String),
  before: Schema.optional(Schema.String),
  limit: Schema.optional(Limit(500)),
});
export type EntriesOptions = typeof EntriesOptions.Type;

const IdempotencyKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const SendRequest = Schema.Struct({
  sessionId: Schema.String,
  /** A string is one text part. */
  content: Schema.Union([
    Schema.String,
    Schema.Array(Schema.Union([TextPart, ImagePart])).check(Schema.isMinLength(1)),
  ]),
  /** The Caller's key for this message, unique within the session (§5.2). */
  idempotencyKey: Schema.optional(IdempotencyKey),
  /** What the message is when the session is busy with another (§5.3). Default: "queue". */
  whenBusy: Schema.optional(Schema.Literals(["queue", "steer", "reject"])),
});
export type SendRequest = typeof SendRequest.Type;

/** In seconds: how long a call waits for a message to end before it answers with the message as it is then. */
export const Wait = Seconds;

/** A message, by its id or by the key it was sent with. */
export const MessageKey = Schema.Union([
  Schema.Struct({ sessionId: Schema.String, messageId: Schema.String }),
  Schema.Struct({ sessionId: Schema.String, idempotencyKey: IdempotencyKey }),
]);
export type MessageKey = typeof MessageKey.Type;

export const CompactOptions = Schema.Struct({ instructions: Schema.optional(Schema.String) });
export type CompactOptions = typeof CompactOptions.Type;

export interface WaitOptions {
  wait?: number;
  signal?: AbortSignal;
}

export interface Agent {
  info(): Promise<AgentInfo>;
  usage(): Promise<Usage>;
  sessions: {
    create(options?: CreateSessionOptions): Promise<Session>;
    get(sessionId: string): Promise<Session>;
    list(options?: ListOptions): Promise<Page<Session>>;
    update(sessionId: string, changes: SessionChanges): Promise<Session>;
    entries(sessionId: string, options?: EntriesOptions): Promise<Page<Entry>>;
    events(sessionId: string, options?: { after?: string; signal?: AbortSignal }): AsyncIterable<SessionEvent>;
    cancel(sessionId: string): Promise<{ stopped: string[] }>;
    compact(sessionId: string, options?: CompactOptions): Promise<void>;
    attachment(sessionId: string, ref: string): Promise<{ mimeType: string; data: Uint8Array }>;
  };
  messages: {
    send(request: SendRequest, options?: WaitOptions): Promise<Message>;
    stream(request: SendRequest, options?: { signal?: AbortSignal }): AsyncIterable<MessageStreamEvent>;
    get(key: MessageKey, options?: WaitOptions): Promise<Message>;
  };
}

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "busy"
  | "missing_model"
  | "missing_tool"
  | "auth_required"
  | "model_error"
  | "unconfirmed"
  | "unavailable"
  | "internal";

export const LIMITS = {
  queuedPerSession: 20,
  inFlightPerProcess: 100,
  pageDefault: 100,
  pageBytes: 4 << 20,
} as const;

const RETRYABLE_CODES: ReadonlySet<string> = new Set<ErrorCode>(["busy", "unavailable"]);

export function agentError(code: ErrorCode, message: string, details?: Json): AgentError {
  return new AgentError({
    code,
    message,
    retryable: RETRYABLE_CODES.has(code),
    ...(details === undefined ? {} : { details }),
  });
}

/** An error as data, the way a message's `error` and a `stream_error` carry it. */
export function errorData(error: AgentErrorData): AgentErrorData {
  const { code, message, retryable, details } = error;
  return { code, message, retryable, ...(details === undefined ? {} : { details }) };
}
