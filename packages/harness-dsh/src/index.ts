/**
 * `@fastagent-sh/harness-dsh`: experimental DeepSeek Harness adapter for FastAgent.
 * Implements the Agent API boundary without coupling `@fastagent-sh/fastagent` to `@deepseek-ai/*`.
 */
/** @public */
export { openDshAgent } from "./agent.ts";
/** @public */
export { MemoryDshEventStore } from "./persistence.ts";
/** @public */
export { buildDshSandboxPolicy } from "./sandbox.ts";
/** @public */
export { toDshToolDefinition } from "./tools.ts";
/** @public */
export type {
  DshAgent,
  DshCommand,
  DshEventStoreBackend,
  DshHarnessOptions,
  DshRetryOptions,
  DshSandboxMode,
  DshSandboxPolicy,
  DshSessionEvent,
  DshSessionHandle,
  DshSessionHeader,
  DshSessionSnapshot,
  DshStoredAttachment,
  DshStoredMessage,
  DshStoredSession,
  DshToolDefinition,
  FastAgentToolApi,
  FastAgentToolLike,
} from "./types.ts";
