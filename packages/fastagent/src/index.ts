/**
 * The package's one entry: the Agent API, opening an agent directory and serving it, and what an author writes.
 */
export type {
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
} from "@fastagent-sh/client/agent-api";
export { AgentError, LIMITS, hasEnded } from "@fastagent-sh/client/agent-api";

export {
  openAgent,
  type LocalAgent,
  type OpenAgentOptions,
  type ServeAgentOptions,
} from "./harnesses/serving.ts";
export type { Service } from "./service.ts";
export {
  openPostgresDatabase,
  type PostgresDatabase,
  type PostgresPoolOptions,
  type SharedPostgresDatabase,
} from "./postgres.ts";
export { McpError, type McpErrorCode } from "./mcp-api.ts";
export { baseEnv } from "./child-env.ts";

export {
  defineAgent,
  type AgentConfig,
  type CodingToolName,
  type CodingToolsConfig,
  type HarnessName,
  type SandboxMode,
} from "./harnesses/define.ts";
export {
  defineTool,
  sessionIdOf,
  type InferToolArgs,
  type StandardJSONSchemaV1,
  type ToolDefinition,
  type ToolParameters,
} from "./harnesses/tool.ts";
export { needs, type Needs, type SecretSpec, type SecretValues } from "./needs.ts";
// What `fastagent build` writes into a package's generated entry, never written by hand.
export { defineDefinition, type AgentDefinition } from "./definition/definition.ts";
