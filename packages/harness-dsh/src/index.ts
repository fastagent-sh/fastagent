/**
 * `@fastagent-sh/harness-dsh`: experimental DeepSeek Harness adapter for FastAgent.
 * Loaded lazily by `@fastagent-sh/fastagent` when `harness: "dsh"` is selected; exposes only the minimal runtime
 * entrypoints needed to open an agent and its stores without leaking internal bridge types.
 */
/** @public */
export { openDshAgent } from "./agent.ts";
/** @public */
export { MemoryDshEventStore } from "./persistence.ts";
/** @public */
export { DshInstanceHeldError, openPostgresDshStore } from "./postgres-store.ts";
/** @public */
export { openSqliteDshStore } from "./sqlite-store.ts";
