/**
 * The Agent API (docs/SPEC.md) as types, plus its limits and error values. Imports nothing: it is the layer
 * that keeps the harness away from its Callers.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Agent {
  info(): AgentInfo;
  invoke(request: InvokeRequest): Promise<InvokeResult>;
  getMessage(
    sessionId: string,
    key: { messageId: string } | { idempotencyKey: string },
  ): Promise<MessageStatus | undefined>;
  createSession(options?: CreateSessionOptions): Promise<CreateSessionResult>;
  configure(sessionId: string, settings: SessionSettings): Promise<ConfigureResult>;
  read(sessionId: string, options?: ReadOptions): Promise<ReadResult>;
  resume(sessionId: string, options?: { replayFrom?: ReplayFrom }): AsyncIterable<ResumeEvent>;
  abort(sessionId: string, options?: { signal?: AbortSignal }): Promise<AbortResult>;
  attachment(sessionId: string, ref: string): Promise<Attachment | undefined>;
  listSessions(options?: ListOptions): Promise<ListResult>;
}

export interface AgentInfo {
  protocolVersion: "1.0";
  name: string;
  description?: string;
  inputs: string[];
  commands: { name: string; description?: string }[];
}

export interface InvokeRequest {
  sessionId?: string;
  content: ContentPart[];
  idempotencyKey?: string;
  whenBusy?: WhenBusy;
}

/** @public */
export type WhenBusy = "queue" | "steer" | "reject";

/** @public */
export interface Receipt {
  sessionId: string;
  message: MessageStatus;
  duplicate: boolean;
}

export type InvokeResult =
  | ({ ok: true } & Receipt & { wait(options?: { signal?: AbortSignal }): Promise<WaitResult> })
  | { ok: false; error: AgentError }
  | { ok: false; unknown: { reason: string; sessionId?: string; messageId?: string } };

export type WaitResult = { ok: true; message: DoneMessage } | { ok: false; unfinished: { reason: string } };

/** What a session answers with. */
export interface SessionSettings {
  model?: { provider: string; modelId: string };
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface CreateSessionOptions extends SessionSettings {
  from?: ForkSource;
}

export type CreateSessionResult = { ok: true; sessionId: string } | { ok: false; error: AgentError };

export type ConfigureResult = { ok: true } | { ok: false; error: AgentError };

/** @public */
export interface ForkSource {
  sessionId: string;
  entryId?: string;
  context?: "full" | "recent";
}

export type ReplayFrom = { type: "start" } | { type: "after"; entryId: string };

export interface ReadOptions {
  after?: string;
  before?: string;
  limit?: number;
}

export type ReadResult =
  | { ok: true; state: SessionState; entries: Entry[]; prev?: string; next?: string }
  | { ok: false; error: AgentError };

export interface ListOptions {
  before?: string;
  limit?: number;
}

export type ListResult =
  | { ok: true; sessions: { sessionId: string }[]; next?: string }
  | { ok: false; error: AgentError };

export type AbortResult =
  | { ok: true; stopped: { taken: string[]; queued: string[] } }
  | { ok: false; error: AgentError }
  | { ok: false; unknown: { reason: string } };

export type ResumeEvent = SessionEvent | { type: "rejected"; error: AgentError };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "image"; mimeType: string; ref: string };

/** @public */
export interface Attachment {
  mimeType: string;
  data: string;
}

export type MessageStatus =
  | { messageId: string; idempotencyKey?: string; status: "queued"; position: number }
  | { messageId: string; idempotencyKey?: string; status: "taken"; entryId: string }
  | DoneMessage;

export interface DoneMessage {
  messageId: string;
  idempotencyKey?: string;
  status: "done";
  entryId?: string;
  outcome: Outcome;
  answer?: { entryId: string; text: string };
}

export type Outcome =
  | { status: "completed" }
  | { status: "max_tokens" }
  | { status: "canceled" }
  | { status: "failed"; error: AgentError };

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
};

/** The session as it is now, its settings included: a field it does not name yet is absent. */
export interface SessionState extends SessionSettings {
  status: "idle" | "running";
  taken: string[];
  queued: string[];
  reply?: { text: string; thinking?: string };
  /** What the session has spent: its own model calls by `provider/model`, and what its tools reported, by tool. */
  usage: { models: Record<string, Usage>; tools: Record<string, Usage> };
}

export interface Entry {
  id: string;
  sessionId: string;
  parentEntryId?: string;
  timestamp: number;
  kind: string;
  data: Json;
}

export type SessionEvent =
  | { type: "entry"; entry: Entry }
  | { type: "done"; message: DoneMessage }
  | { type: "state"; state: SessionState }
  | { type: "message_delta"; channel: "text" | "thinking"; delta: string }
  | { type: "tool_started"; toolCallId: string; name: string; args: Json }
  | { type: "tool_progress"; toolCallId: string; text: string }
  | { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "serving_error"; error: AgentError };

export interface AgentError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Json;
}

export type ErrorCode =
  | "invalid_request"
  | "not_found"
  | "busy"
  | "missing_model"
  | "auth_required"
  | "model_error"
  | "unavailable"
  | "internal";

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

/** What `getMessage` and `attachment` reject with when the Agent's storage cannot answer (§2). */
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
