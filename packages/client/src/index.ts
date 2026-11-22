/**
 * The Agent API over HTTP, for a program anywhere `fetch` runs: `connectAgent`, its errors and the
 * types. It opens no agent and needs no Node API, so it also runs on Deno and Workers.
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
  CreateSessionOptions,
  EntriesOptions,
  Entry,
  ErrorCode,
  InvokeApi,
  InvokeRequest,
  Json,
  ListOptions,
  Message,
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
