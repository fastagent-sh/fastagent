/**
 * The Agent API as Effect Schemas: its objects, what a Caller sends, its errors and its
 * limits. Imports only `effect`: it is the layer that keeps the harness away from its Callers, and the HTTP binding is
 * built from the same schemas, so the two bindings cannot describe different APIs.
 */
import * as Schema from "effect/Schema";

export type Json = Schema.Json;

/** Agent-owned identifier for a durable session. */
export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

/** Agent-owned identifier for a recorded message. */
export const MessageId = Schema.String.pipe(Schema.brand("MessageId"));
export type MessageId = typeof MessageId.Type;

/** Caller-owned name for a persistent conversation resolved by `POST /v1/invoke`. */
export const ConversationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand("ConversationId"),
);
export type ConversationId = typeof ConversationId.Type;

/** Caller-owned key deduplicating retries within a session or ephemeral invoke. */
export const IdempotencyKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).pipe(
  Schema.brand("IdempotencyKey"),
);
export type IdempotencyKey = typeof IdempotencyKey.Type;

export const ModelRef = Schema.Struct({ provider: Schema.String, modelId: Schema.String });
export type ModelRef = typeof ModelRef.Type;

export const ThinkingLevel = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = typeof ThinkingLevel.Type;

export class Tokens extends Schema.Opaque<Tokens>()(
  Schema.Struct({
    inputTokens: Schema.Finite,
    outputTokens: Schema.Finite,
    cacheReadTokens: Schema.optionalKey(Schema.Finite),
    cacheWriteTokens: Schema.optionalKey(Schema.Finite),
    cost: Schema.optionalKey(Schema.Finite),
  }),
) {}

/** Spend by `provider/model` for model calls, and by tool name for what tools reported. */
export class Usage extends Schema.Opaque<Usage>()(
  Schema.Struct({
    models: Schema.Record(Schema.String, Tokens),
    tools: Schema.Record(Schema.String, Tokens),
  }),
) {}

const Named = Schema.Struct({ name: Schema.String, description: Schema.optionalKey(Schema.String) });

/** The program an instance runs: its own name and description, whatever the instance is called. */
const AgentProgram = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
});

export class AgentInfo extends Schema.Opaque<AgentInfo>()(
  Schema.Struct({
    /** The instance's name. */
    name: Schema.String,
    /** The program the instance runs. */
    agent: AgentProgram,
    /**
     * Example first messages: text a Caller may offer to put in a composer, never to send for the person. The
     * program's, unless the instance gives its own.
     */
    starters: Schema.optionalKey(Schema.Array(Schema.String)),
    /** What a message may start with as `/<name>`. */
    commands: Schema.Array(Named),
    /** The tools a session may enable. */
    tools: Schema.Array(Named),
    /**
     * The models a session may name: those whose provider has a credential here. `contextWindow`, in tokens, is the
     * window the agent runs the model with, absent when the model declares none. `thinkingLevels` are the levels the
     * model supports, lowest first: `["off"]` for a model that does not reason.
     */
    models: Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        modelId: Schema.String,
        name: Schema.optionalKey(Schema.String),
        contextWindow: Schema.optionalKey(Schema.Finite),
        thinkingLevels: Schema.Array(ThinkingLevel),
      }),
    ),
    /** The model a session answers with when it names none; absent when none is set, or the one set is `unusableDefault`. */
    defaultModel: Schema.optionalKey(ModelRef),
    /**
     * The default model the configuration names and this agent does not have, as the configuration wrote it, and why
     * (a provider retired it, a catalog update renamed it). The agent opens without a default, and a message that names
     * no model is refused `missing_model`.
     */
    unusableDefault: Schema.optionalKey(Schema.Struct({ spec: Schema.String, reason: Schema.String })),
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

/** What every operation rejects with. */
export class AgentError extends Schema.Error<AgentError, { readonly brand: unique symbol }>("AgentError")(
  AgentErrorData,
) {}

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

/**
 * A status as a field: the values this version defines, and any other, since a later version may add one and a Caller
 * reads it as an unknown value of an open set (an unknown session status is busy, an unknown message status has
 * not ended).
 */
const open = <S extends Schema.Top>(known: S) =>
  // As a type, the known values and any string, so an editor still offers them (`string & {}` does not absorb them).
  Schema.Union([known, Schema.String]) as unknown as Schema.Codec<S["Type"] | (string & {}), string>;

export const SessionStatus = Schema.Literals(["idle", "running"]);
export type SessionStatus = typeof SessionStatus.Type;

const SessionTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** A tool call in the session's current tool round, present while it has not finished. */
export const ActiveTool = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["pending", "running"]),
  progress: Schema.optionalKey(Schema.String),
});
export type ActiveTool = typeof ActiveTool.Type;

/** A message waiting in the session's inbox for the current turn or run to take it. */
export const QueuedMessage = Schema.Struct({
  id: MessageId,
  mode: Schema.Literals(["steer", "queue"]),
});
export type QueuedMessage = typeof QueuedMessage.Type;

/** Current context-window occupancy of the session's active branch (clears after compaction until the next answer). */
export const ContextUsage = Schema.Struct({
  tokens: Schema.Finite,
  contextWindow: Schema.optionalKey(Schema.Finite),
});
export type ContextUsage = typeof ContextUsage.Type;

export class Session extends Schema.Opaque<Session>()(
  Schema.Struct({
    id: SessionId,
    status: open(SessionStatus),
    title: Schema.optionalKey(Schema.String),
    createdAt: Schema.optionalKey(Schema.Finite),
    updatedAt: Schema.optionalKey(Schema.Finite),
    ...settingsFields(Schema.optionalKey),
    /** The agent's reply being written, as written so far: present only while one is. */
    reply: Schema.optionalKey(Schema.Struct({ text: Schema.String, thinking: Schema.optionalKey(Schema.String) })),
    /** Tool calls currently pending or running in the active round; absent when none. */
    activeTools: Schema.optionalKey(Schema.Array(ActiveTool)),
    /** Messages queued behind the current work; absent when none. */
    queuedMessages: Schema.optionalKey(Schema.Array(QueuedMessage)),
    /** Present and true while a compaction task is running for this session. */
    compacting: Schema.optionalKey(Schema.Boolean),
    /** Latest context window occupancy in the active branch; absent before the first answer or right after compaction. */
    contextUsage: Schema.optionalKey(ContextUsage),
    usage: Usage,
  }),
) {}

/** A message's statuses: `queued` and `running` until it ends, then one of the four ends, which are all its ends. */
/**
 * The Caller's own data on a message, such as where its answer goes: kept with the message, returned with it, never
 * shown to the model. At most 16 keys of 1 to 64 characters, each value a string of at most 512.
 */
export const Metadata = Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(512))).check(
  Schema.isMaxProperties(16),
  // A Record's key schema is not checked on decode, so the key bounds are a filter of their own.
  Schema.makeFilter((metadata) =>
    Object.keys(metadata)
      .filter((key) => key.length < 1 || key.length > 64)
      .map((key) => ({ path: [key], issue: "a metadata key is 1 to 64 characters" })),
  ),
);
export type Metadata = typeof Metadata.Type;

export const MessageStatus = Schema.Literals(["queued", "running", "completed", "incomplete", "failed", "canceled"]);
export type MessageStatus = typeof MessageStatus.Type;

export class Message extends Schema.Opaque<Message>()(
  Schema.Struct({
    id: MessageId,
    sessionId: SessionId,
    idempotencyKey: Schema.optionalKey(IdempotencyKey),
    metadata: Schema.optionalKey(Metadata),
    status: open(MessageStatus),
    /** Its `user` entry, once the agent took it. */
    entryId: Schema.optionalKey(Schema.String),
    /** The `assistant` entry the agent stopped on for it: when `completed`, and when `incomplete`. */
    answer: Schema.optionalKey(Schema.Struct({ entryId: Schema.String, text: Schema.String })),
    /** Why it `failed`. */
    error: Schema.optionalKey(AgentErrorData),
  }),
) {}

const ENDS: ReadonlySet<string> = new Set<MessageStatus>(["completed", "incomplete", "failed", "canceled"]);

/** Whether a message has ended: its ends are a closed set, so any other status, known or not, has not. */
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
  Schema.Struct({ id: Schema.String, timestamp: Schema.Finite, kind: Schema.String, data: Schema.Json }),
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
  Schema.Struct({
    type: Schema.Literal("tool_progress"),
    toolCallId: Schema.String,
    text: Schema.String,
    output: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("retrying"),
    attempt: Schema.Finite,
    maxAttempts: Schema.Finite,
    delayMs: Schema.Finite,
    reason: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("compaction_started"),
    trigger: Schema.Literals(["manual", "threshold", "overflow"]),
  }),
  Schema.Struct({
    type: Schema.Literal("compaction_failed"),
    error: Schema.String,
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
const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const SessionSettings = Schema.Struct(settingsFields(Schema.optional));
export type SessionSettings = typeof SessionSettings.Type;

export const CreateSessionOptions = Schema.Struct({
  title: Schema.optional(SessionTitle),
  ...settingsFields(Schema.optional),
  forkFrom: Schema.optional(Schema.Struct({ sessionId: SessionId, entryId: Schema.optional(Schema.String) })),
});
export type CreateSessionOptions = typeof CreateSessionOptions.Encoded;

/** `null` clears a field back to the deployment's. */
export const SessionChanges = Schema.Struct({
  title: Schema.optional(Schema.NullOr(SessionTitle)),
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

export const SendRequest = Schema.Struct({
  sessionId: SessionId,
  /** A string is one text part. */
  content: Schema.Union([
    Schema.String,
    Schema.Array(Schema.Union([TextPart, ImagePart])).check(Schema.isMinLength(1)),
  ]),
  /** The Caller's key for this message, unique within the session. */
  idempotencyKey: Schema.optional(IdempotencyKey),
  metadata: Schema.optional(Metadata),
  /** What the message is when the session is busy with another. Default: "queue". */
  whenBusy: Schema.optional(Schema.Literals(["queue", "steer", "reject"])),
});
export type SendRequest = typeof SendRequest.Encoded;

/** In seconds: how long a call waits for a message to end before it answers with the message as it is then. */
export const Wait = Seconds;

/** A message, by its id or by the key it was sent with. */
export const MessageKey = Schema.Union([
  Schema.Struct({ sessionId: SessionId, messageId: MessageId }),
  Schema.Struct({ sessionId: SessionId, idempotencyKey: IdempotencyKey }),
]);
export type MessageKey = typeof MessageKey.Encoded;
export type DecodedMessageKey = typeof MessageKey.Type;

export const InvokeRequest = Schema.Struct({
  /** Text or content parts; supports `/<command>` templates from `prompts/` and `skills/`. */
  content: SendRequest.fields.content,
  /**
   * Caller-chosen conversation name (e.g. `"daily-digest"`, `"slack:C123:456"`). Reuses its mapped session, or
   * creates one titled with this name if absent or previously deleted. Mutually exclusive with `sessionId`.
   */
  conversation: Schema.optional(ConversationId),
  /** Existing session id to send into (strict: refuses `not_found` if absent). Mutually exclusive with `conversation`. */
  sessionId: Schema.optional(SessionId),
  /** Settings applied when creating a session, or updating an existing session when explicitly given. */
  session: Schema.optional(SessionSettings),
  /** Caller key preventing duplicate sessions (when ephemeral) and duplicate messages on retry. */
  idempotencyKey: Schema.optional(IdempotencyKey),
  metadata: Schema.optional(Metadata),
  /** What the message is when the session is busy with another. Default: "queue". */
  whenBusy: Schema.optional(Schema.Literals(["queue", "steer", "reject"])),
});
export type InvokeRequest = typeof InvokeRequest.Encoded;
export type DecodedInvokeRequest = typeof InvokeRequest.Type;

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
    delete(sessionId: string): Promise<void>;
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

/** Single-call invocation over an Agent, resolving or creating a session by `conversation` or ephemeral key. */
export interface InvokeApi {
  invoke(request: InvokeRequest, options?: WaitOptions): Promise<Message>;
  invokeStream(request: InvokeRequest, options?: { signal?: AbortSignal }): AsyncIterable<MessageStreamEvent>;
}

/** An Agent client that also exposes single-call `invoke` / `invokeStream`. */
export interface RemoteAgent extends Agent, InvokeApi {}

export const AuthMethod = Schema.Literals(["oauth", "api_key"]);
export type AuthMethod = typeof AuthMethod.Type;

export class AuthProviderStatus extends Schema.Opaque<AuthProviderStatus>()(
  Schema.Struct({
    provider: Schema.String,
    name: Schema.String,
    methods: Schema.Array(AuthMethod),
    authenticated: Schema.Boolean,
    source: Schema.optionalKey(Schema.String),
    stored: Schema.optionalKey(AuthMethod),
    error: Schema.optionalKey(Schema.String),
  }),
) {}

const AuthPromptOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
});

export class AuthPromptInfo extends Schema.Opaque<AuthPromptInfo>()(
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literals(["text", "secret", "select", "manual_code"]),
    message: Schema.String,
    placeholder: Schema.optionalKey(Schema.String),
    options: Schema.optionalKey(Schema.Array(AuthPromptOption)),
  }),
) {}

export const AuthFlowStatus = Schema.Literals(["pending", "awaiting_input", "completed", "failed", "canceled"]);
export type AuthFlowStatus = typeof AuthFlowStatus.Type;

export class AuthFlowState extends Schema.Opaque<AuthFlowState>()(
  Schema.Struct({
    flowId: Schema.String,
    provider: Schema.String,
    method: AuthMethod,
    status: AuthFlowStatus,
    authUrl: Schema.optionalKey(
      Schema.Struct({
        url: Schema.String,
        instructions: Schema.optionalKey(Schema.String),
      }),
    ),
    deviceCode: Schema.optionalKey(
      Schema.Struct({
        userCode: Schema.String,
        verificationUri: Schema.String,
        intervalSeconds: Schema.optionalKey(Schema.Finite),
        expiresInSeconds: Schema.optionalKey(Schema.Finite),
      }),
    ),
    prompt: Schema.optionalKey(AuthPromptInfo),
    messages: Schema.Array(Schema.String),
    verified: Schema.optionalKey(Schema.Literals(["ok", "unknown", "n/a"])),
    error: Schema.optionalKey(Schema.String),
  }),
) {}

export const StartAuthLoginRequest = Schema.Struct({
  provider: Schema.String.check(Schema.isMinLength(1)),
  method: Schema.optional(AuthMethod),
});
export type StartAuthLoginRequest = typeof StartAuthLoginRequest.Type;

export const AuthLoginInput = Schema.Struct({
  promptId: Schema.String.check(Schema.isMinLength(1)),
  value: Schema.String,
});
export type AuthLoginInput = typeof AuthLoginInput.Type;

/** Remote model-provider authentication API backed by the instance's durable storage. */
export interface AuthApi {
  /** List providers the instance supports and their current authentication state. */
  providers(): Promise<AuthProviderStatus[]>;
  /** Start an interactive OAuth or API-key login flow on the instance. */
  startLogin(request: StartAuthLoginRequest, options?: { signal?: AbortSignal }): Promise<AuthFlowState>;
  /** Read (or long-poll with `wait`) an in-flight or settled login flow. */
  getLogin(flowId: string, options?: WaitOptions): Promise<AuthFlowState>;
  /** Supply user input (code, callback URL, API key, selection) for the flow's active prompt. */
  submitInput(flowId: string, input: AuthLoginInput, options?: { signal?: AbortSignal }): Promise<AuthFlowState>;
  /** Cancel an in-flight login flow. */
  cancelLogin(flowId: string): Promise<void>;
  /** Remove the stored credential for `provider` from the instance's durable storage. */
  logout(provider: string): Promise<{ removed: boolean }>;
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
  /** The longest one HTTP request waits for a message; `connectAgent` asks again until its Caller's `wait` is met. */
  httpWaitSeconds: 60,
  /** The longest a single `POST /v1/invoke` request may wait for a turn to finish (for scale-to-zero callers). */
  invokeWaitSeconds: 600,
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

/** Validate `input` against an Agent API Schema, throwing `AgentError("invalid_request")` on failure. */
export function decodeRequest<S extends Schema.Top>(schema: S, input: unknown, what: string): S["Type"] {
  try {
    return (Schema.decodeUnknownSync as (s: S) => (u: unknown) => S["Type"])(schema)(input);
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/\s*\n\s*/g, " ") : String(error);
    throw agentError("invalid_request", `${what}: ${message}`);
  }
}
