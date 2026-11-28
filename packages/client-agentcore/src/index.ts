/**
 * Zero-Node-dependency client for FastAgent instances running on Amazon Bedrock AgentCore: wraps `InvokeAgentRuntime`
 * into a custom `fetch` transport passed directly to `@fastagent-sh/client`'s `connectAgent()`.
 */
import type { RemoteAgent } from "@fastagent-sh/client/agent-api";
import { connectAgent } from "@fastagent-sh/client";
import { type AgentCoreConnection, agentCoreTransport } from "./transport.ts";

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
  SessionEvent,
  SessionId,
  SessionSettings,
  SessionStatus,
  ThinkingLevel,
  Tokens,
  Usage,
  WaitOptions,
} from "@fastagent-sh/client/agent-api";
/** @public */
export { AgentError, LIMITS, hasEnded } from "@fastagent-sh/client/agent-api";
/** @public */
export { type ConnectOptions, connectAgent } from "@fastagent-sh/client";
/** @public */
export type { AgentCoreConnection } from "./transport.ts";

/**
 * Connect to the FastAgent instance for `sessionId` on the Amazon Bedrock AgentCore runtime `runtimeArn`.
 * @public
 */
export function connectAgentCore(connection: AgentCoreConnection): RemoteAgent {
  const { url, fetch } = agentCoreTransport(connection);
  return connectAgent(url, { fetch });
}
