/**
 * The Agent API and Auth API over HTTP, for any runtime where `fetch` exists: `connectAgent`, `connectAuth`,
 * `AgentError`, and all contract types. Zero Node dependencies, so it also runs on Bun, Deno, and Workers.
 */
/** @public */
export type {
  ActiveTool,
  Agent,
  AgentErrorData,
  AgentInfo,
  AuthApi,
  AuthFlowState,
  AuthFlowStatus,
  AuthLoginInput,
  AuthMethod,
  AuthPromptInfo,
  AuthProviderStatus,
  CompactOptions,
  ContentPart,
  ContextUsage,
  ConversationId,
  CreateSessionOptions,
  EntriesOptions,
  Entry,
  ErrorCode,
  IdempotencyKey,
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
  QueuedMessage,
  RemoteAgent,
  SendRequest,
  Session,
  SessionChanges,
  SessionId,
  SessionEvent,
  SessionSettings,
  SessionStatus,
  StartAuthLoginRequest,
  ThinkingLevel,
  Tokens,
  Usage,
  WaitOptions,
} from "./agent-api.ts";
/** @public */
export { AgentError, LIMITS, hasEnded } from "./agent-api.ts";

/** @public */
export { connectAgent, connectAuth, type ConnectOptions } from "./http/client.ts";
