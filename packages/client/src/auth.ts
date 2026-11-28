/**
 * Remote provider Auth API over HTTP (`connectAuth` and Auth API types), kept off `@fastagent-sh/client`'s root
 * entry so callers that only use the Agent API (`connectAgent`) see a minimal surface. Zero Node dependencies.
 */
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
} from "./agent-api.ts";

/** @public */
export { connectAuth, type ConnectOptions } from "./http/client.ts";
