/**
 * The Agent API over HTTP, for any runtime where `fetch` exists: `connectAgent`, `AgentError`, and all core Agent API
 * types. Remote provider OAuth/API-key sign-in lives at `@fastagent-sh/client/auth`. Zero Node dependencies, so it
 * runs on Node, Bun, Deno, browsers, and edge workers.
 */
/** @public */
export type {
  ActiveTool,
  Agent,
  AgentErrorData,
  AgentInfo,
  CompactOptions,
  ContentPart,
  ContextUsage,
  ConversationId,
  CreateSessionOptions,
  EntriesOptions,
  Entry,
  ErrorCode,
  IdempotencyKey,
  InterruptId,
  InterruptKind,
  InterruptResolution,
  InvokeApi,
  InvokeRequest,
  Json,
  ListOptions,
  Message,
  MessageId,
  MessageKey,
  MessageStatus,
  MessageStreamEvent,
  Metadata,
  ModelRef,
  Page,
  PendingInterrupt,
  QueuedMessage,
  RemoteAgent,
  ResolveInterruptRequest,
  SendRequest,
  Session,
  SessionChanges,
  SessionId,
  SessionEvent,
  SessionSettings,
  SessionStatus,
  ThinkingLevel,
  Tokens,
  Usage,
  WaitOptions,
} from "./agent-api.ts";
/** @public */
export { AgentError, LIMITS, hasEnded, isAwaitingAction } from "./agent-api.ts";

/** @public */
export { connectAgent, type ConnectOptions } from "./http/client.ts";
