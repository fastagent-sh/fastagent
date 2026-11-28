/**
 * An agent on Amazon Bedrock AgentCore, from wherever the AWS SDK runs: the Agent API, as `connectAgent` gives it,
 * each request one `InvokeAgentRuntime` on the session (signed with the SDK's credentials), wrapped as the runtime
 * unwraps it (`contract.ts`). Remote provider Auth API lives at `@fastagent-sh/client-agentcore/auth`.
 *
 * Also implements FastAgent's pluggable `RemoteTransportModule` (`connectRemote`) so `remotes.json` entries with
 * `type: "agentcore"` work automatically across FastAgent CLI and `@fastagent-sh/pi-remote` without hardcoding
 * AgentCore inside `@fastagent-sh/client`, `@fastagent-sh/fastagent`, or `@fastagent-sh/pi-remote`.
 *
 * Zero server, database, CDK, or Node-only dependencies; installs `@aws-sdk/client-bedrock-agentcore` and `@fastagent-sh/client` directly.
 */
import type { RemoteAgent } from "@fastagent-sh/client/agent-api";
import { connectAgent } from "@fastagent-sh/client";
import type { ExtensionRemoteConfig, RemoteConnection, RemoteConnectOptions } from "@fastagent-sh/client/remotes";
import { connectAgentCoreAuth } from "./auth.ts";
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
 * The Agent of the session `sessionId` on the runtime `runtimeArn`.
 * @public
 */
export function connectAgentCore(connection: AgentCoreConnection): RemoteAgent {
  const { url, fetch } = agentCoreTransport(connection);
  return connectAgent(url, { fetch });
}

/**
 * Pluggable `remotes.json` transport entry for `type: "agentcore"`, invoked lazily by FastAgent CLI and
 * `@fastagent-sh/pi-remote`.
 * @public
 */
export function connectRemote(
  name: string,
  config: ExtensionRemoteConfig,
  options?: RemoteConnectOptions,
): RemoteConnection {
  if (options?.key !== undefined) {
    throw new Error(`--key cannot be used with AgentCore remote "${name}"`);
  }
  const runtimeArn = typeof config.runtimeArn === "string" ? config.runtimeArn.trim() : "";
  if (!runtimeArn) {
    throw new Error(`Remote "${name}" requires a non-empty "runtimeArn"`);
  }
  const sessionId = typeof config.sessionId === "string" ? config.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error(`Remote "${name}" requires a non-empty "sessionId" for AgentCore`);
  }
  if (config.qualifier !== undefined && typeof config.qualifier !== "string") {
    throw new Error(`Remote "${name}" field "qualifier" must be a string`);
  }
  const connection: AgentCoreConnection = {
    runtimeArn,
    sessionId,
    ...(config.qualifier !== undefined ? { qualifier: config.qualifier } : {}),
  };
  return {
    agent: connectAgentCore(connection),
    auth: connectAgentCoreAuth(connection),
    label: `${name} (${runtimeArn})`,
  };
}
