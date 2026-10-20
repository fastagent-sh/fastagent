/**
 * Agent Handler protocol v1 (docs/SPEC.md), the contract every caller uses. Pure types and the protocol's own
 * constants: no harness, no runtime.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ImageRef {
  mimeType: string;
  data: string;
}

export interface Prompt {
  text: string;
  images?: ImageRef[];
}

export type Attachment = ImageRef;

export type WhenBusy = "queue" | "steer" | "reject";

export type MessageSource = { kind: "channel" | "schedule" | "wake" | "api"; name?: string };

export interface InvokeRequest {
  sessionId?: string;
  prompt: Prompt;
  whenBusy?: WhenBusy;
  idempotencyKey?: string;
  /** Set in process only: a transport refuses a request that carries it (SPEC v1 §3.5). */
  source?: { kind: "channel" | "schedule" | "wake"; name?: string };
}

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
};

export type Outcome =
  | { status: "completed" }
  | { status: "max_tokens" }
  | { status: "intercepted" }
  | { status: "interrupted" }
  | { status: "canceled" }
  | { status: "failed"; error: AgentError };

export type DoneMessage = {
  messageId: string;
  idempotencyKey?: string;
  source?: MessageSource;
  status: "done";
  entryId?: string;
  takenAt?: number;
  endedAt: number;
  outcome: Outcome;
  /** The reply the agent stopped on: only when the outcome is `completed` or `max_tokens` (SPEC v1 §4). */
  answer?: { entryId: string; text: string };
};

export type MessageStatus =
  | ({ messageId: string; idempotencyKey?: string; source?: MessageSource } & (
      | { status: "queued"; position: number }
      | { status: "taken"; entryId: string; takenAt: number }
    ))
  | DoneMessage;

export type MessageKey = { messageId: string } | { idempotencyKey: string };

export interface Entry {
  id: string;
  parentEntryId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}

export interface SessionState {
  name?: string;
  status: "idle" | "running" | "compacting";
  taken: { messageId: string; takenAt: number }[];
  /** In the order they will be taken: steered messages first. */
  queued: { messageId: string; idempotencyKey?: string; preview: string }[];
  model?: string;
  thinkingLevel?: string;
  thinkingLevels?: string[];
  context?: { tokens?: number; window?: number };
  leafEntryId?: string;
}

export interface SessionSummary {
  sessionId: string;
  name?: string;
  status: "idle" | "running";
  createdAt: number;
  updatedAt: number;
  preview?: string;
}

/**
 * What a session is doing, as it happens, and not durable: a reconnecting caller sees the entries it missed, not these.
 * They are the session's: what the agent does while it answers its taken messages, or a compaction.
 */
export type LiveEvent =
  | { type: "message_delta"; channel: "text" | "thinking"; delta: string }
  | { type: "tool_started"; toolCallId: string; name: string; args: Json }
  | { type: "tool_progress"; toolCallId: string; text: string }
  | { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; reason: string };

export type SessionEvent =
  | { type: "entry"; entry: Entry }
  /** A message that ended, from its durable record: it ends that message's follow and invoke stream. */
  | { type: "done"; message: DoneMessage }
  | { type: "state"; state: SessionState }
  | LiveEvent
  | { type: "serving_error"; message: string };

export type InvokeEvent =
  | { type: "accepted"; sessionId: string; message: MessageStatus; duplicate: boolean }
  | { type: "rejected"; error: AgentError }
  | SessionEvent;

export type FollowEvent = SessionEvent | { type: "rejected"; error: AgentError };

export type ErrorCode =
  | "invalid_request"
  | "unsupported"
  | "not_found"
  | "conflict"
  | "busy"
  | "missing_model"
  | "auth_required"
  | "model_error"
  | "nothing_to_compact"
  | "partial_update"
  | "unavailable"
  | "internal";

export type AgentError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Json;
};

export type Result = { ok: true } | { ok: false; error: AgentError };

export type AbortResult =
  | { ok: true; stopped: { taken: string[]; queued: string[]; compaction: boolean } }
  | { ok: false; error: AgentError };

export type ReadResult =
  | { ok: true; state: SessionState; entries: Entry[]; next?: string; prev?: string }
  | { ok: false; error: AgentError };

type CreateResult = { ok: true; sessionId: string } | { ok: false; error: AgentError };

/** Where a new session starts from (§5). `context: "recent"` gives the model only the copy's recent part. */
export interface ForkSource {
  sessionId: string;
  entryId?: string;
  context?: "full" | "recent";
}

type UpdatableField = "name" | "model" | "thinkingLevel";

export type SessionSettings = { name?: string; model?: string; thinkingLevel?: string };

export interface Capabilities {
  steer: boolean;
  fork: boolean;
  rewind: boolean;
  compaction: boolean;
  delete: boolean;
  updatable: UpdatableField[];
  durableQueue: boolean;
  durableTaken: boolean;
  toolProgress: boolean;
  usage: boolean;
}

export interface AgentInfo {
  protocolVersion: "1.0";
  capabilities: Capabilities;
}

export interface ModelDescriptor {
  spec: string;
  name?: string;
  thinkingLevels: string[];
  contextWindow?: number;
}

export interface AgentCommand {
  name: string;
  description?: string;
  source: string;
}

export interface Agent {
  invoke(request: InvokeRequest): AsyncIterable<InvokeEvent>;
  sessions: {
    create(options?: { sessionId?: string; fork?: ForkSource }): Promise<CreateResult>;
    list(): Promise<SessionSummary[]>;
    get(sessionId: string): Session;
  };
  info(): AgentInfo;
  models(): Promise<ModelDescriptor[]>;
  commands(): Promise<AgentCommand[]>;
}

export interface Session {
  readonly sessionId: string;
  read(options?: { after?: string; before?: string; limit?: number }): Promise<ReadResult>;
  follow(options?: { after?: string }): AsyncIterable<FollowEvent>;
  attachment(ref: string): Promise<Attachment | undefined>;
  abort(): Promise<AbortResult>;
  rewind(entryId: string): Promise<Result>;
  compact(options?: { instructions?: string }): Promise<Result>;
  update(settings: SessionSettings): Promise<Result>;
  delete(): Promise<Result>;
  messages: {
    get(key: MessageKey): Promise<MessageStatus | undefined>;
    follow(messageId: string, options?: { after?: string }): AsyncIterable<FollowEvent>;
    cancel(messageId: string): Promise<Result>;
  };
}

/** SPEC v1 §7.2. */
export const LIMITS = {
  queuedPerSession: 20,
  inFlightPerProcess: 100,
  readDefault: 100,
  readMax: 500,
  pageBytes: 4 << 20,
  idempotencyKeyMax: 256,
} as const;

const RETRYABLE_CODES: ReadonlySet<string> = new Set<ErrorCode>(["busy", "unavailable"]);

export function agentError(code: ErrorCode, message: string, details?: Json): AgentError {
  return { code, message, retryable: RETRYABLE_CODES.has(code), ...(details === undefined ? {} : { details }) };
}

export function failure(code: ErrorCode, message: string, details?: Json): { ok: false; error: AgentError } {
  return { ok: false, error: agentError(code, message, details) };
}

/** What `sessions.list`, `messages.get`, `attachment`, `models` and `commands` reject with (SPEC v1 §2). */
export class AgentRejection extends Error implements AgentError {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Json;
  constructor(error: AgentError, options?: { cause?: unknown }) {
    super(error.message, options);
    this.name = "AgentRejection";
    this.code = error.code;
    this.retryable = error.retryable;
    if (error.details !== undefined) this.details = error.details;
  }
}

/** `""`, `.` and `..` cannot be addressed by a URL, so no session or entry may be named so. */
export function isAddressable(id: string): boolean {
  return id !== "" && id !== "." && id !== "..";
}
