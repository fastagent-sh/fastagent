/**
 * `@fastagent-sh/harness-dsh`: experimental DeepSeek Harness adapter for FastAgent.
 * Implements the Agent API boundary without coupling `@fastagent-sh/fastagent` to `@deepseek-ai/*`.
 */
/** @public */
export { openDshAgent } from "./agent.ts";
/** @public */
export { MemoryDshEventStore } from "./persistence.ts";
/** @public */
export {
  DshInstanceHeldError,
  openPostgresDshStore,
  type DshPgCreateIndex,
  type DshPgDatabase,
  type DshPgExecutor,
  type DshPgLease,
  type DshPgLeaseHandoff,
  type DshPgLimits,
  type DshPgStoreKit,
  type PostgresDshEventStore,
  type PostgresDshStoreOptions,
} from "./postgres-store.ts";
/** @public */
export {
  openSqliteDshStore,
  type SqliteDshEventStore,
  type SqliteDshStoreOptions,
} from "./sqlite-store.ts";
/** @public */
export type {
  DshAgent,
  DshCodingToolName,
  DshCommand,
  DshEventStoreBackend,
  DshHarnessOptions,
  DshRetryOptions,
  DshSandboxMode,
  DshTelemetryContext,
  DshTelemetrySpan,
  FastAgentToolApi,
  FastAgentToolLike,
} from "./types.ts";
