/**
 * Remote provider Auth API (`/v1/auth/*`) over Amazon Bedrock AgentCore (`connectAgentCoreAuth`), kept off the root
 * entry so Agent API callers see a minimal surface. Zero server, database, or Node-only dependencies.
 */
import type { AuthApi } from "@fastagent-sh/client/auth";
import { connectAuth } from "@fastagent-sh/client/auth";
import { type AgentCoreConnection, agentCoreTransport } from "./transport.ts";

/** @public */
export type {
  AuthApi,
  AuthFlowState,
  AuthFlowStatus,
  AuthLoginInput,
  AuthMethod,
  AuthPromptInfo,
  AuthProviderStatus,
  StartAuthLoginRequest,
} from "@fastagent-sh/client/auth";
/** @public */
export { type ConnectOptions, connectAuth } from "@fastagent-sh/client/auth";
/** @public */
export type { AgentCoreConnection } from "./transport.ts";

/**
 * The Auth API (remote model-provider login and logout) of the session `sessionId` on the runtime `runtimeArn`.
 * @public
 */
export function connectAgentCoreAuth(connection: AgentCoreConnection): AuthApi {
  const { url, fetch } = agentCoreTransport(connection);
  return connectAuth(url, { fetch });
}
