/**
 * The package's one entry: the Agent API, opening an agent directory and serving it, and what an author writes.
 */
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
  type PortableTool,
  type StandardJSONSchemaV1,
  type ToolDefinition,
  type ToolDetails,
  type ToolExecutionApi,
  type ToolExecutionContext,
  type ToolOutputLimits,
  type ToolOutputPart,
  type ToolParameters,
  type ToolResult,
} from "./harnesses/tool.ts";
export { needs, type Needs, type SecretSpec, type SecretValues } from "./needs.ts";
export type { AgentDefinition } from "./definition/definition.ts";
