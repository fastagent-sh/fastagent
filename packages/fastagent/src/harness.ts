/**
 * SDK entry (`@fastagent-sh/fastagent/harness`) for server-grade runtime harness plugins (`@fastagent-sh/harness-<name>`).
 * Centralizes the two-phase `HarnessProvider` contract, portable tool/command/telemetry types, PostgreSQL single-writer
 * storage primitives, `pi-ai` error classification, and async event channel helpers without pulling in
 * `@earendil-works/pi-durable`, `@earendil-works/chord`, or any `@deepseek-ai/*` package.
 */
import type { Models } from "@earendil-works/pi-ai";
import type { Agent, AgentInfo, ModelRef } from "@fastagent-sh/client/agent-api";
import type { WorkTracker } from "./busy.ts";
import type { AgentDefinition } from "./definition/definition.ts";
import type { AuthoredTool, BuiltDefinition, Unfinished } from "./harnesses/assembly.ts";
import type { HarnessSelection } from "./harnesses/config.ts";
import type { CodingToolName } from "./harnesses/define.ts";
import type { AgentCommand } from "./harnesses/text.ts";
import type { PortableTool } from "./harnesses/tool.ts";
import type { PostgresDatabase, SharedPostgresDatabase } from "./postgres.ts";
import type { PgLeaseHandoff } from "./postgres-kit.ts";
import type { RunsAs } from "./serving-command.ts";

export { INSTANCE_NAME_ENV } from "./instance-name.ts";
export { Unavailable } from "./unavailable.ts";
export {
  DEFAULT_LEASE_MS,
  DEFAULT_LEASE_WAIT_MS,
  InstanceHeld,
  acquirePgInstanceLease,
  isPgConflict,
  migratePgSchema,
  type MigratePgSchemaOptions,
  type PgInstanceLease,
  type PgLeaseHandoff,
} from "./postgres-kit.ts";
export {
  describeDatabase,
  isTransientPgError,
  sharedHandleOf,
  type PgDatabase,
  type PgExecutor,
  type PostgresDatabase,
  type SharedPostgresDatabase,
  type SharedPostgresHandle,
} from "./postgres.ts";
export { classifyPiAiError, toPiThinkingLevel, type PiAiErrorCode } from "./harnesses/models/pi-ai-bridge.ts";
export {
  retainToolOutput,
  type PortableTool,
  type ToolDetails,
  type ToolExecutionApi,
  type ToolExecutionContext,
  type ToolOutputLimits,
  type ToolOutputPart,
  type ToolResult,
} from "./harnesses/tool.ts";
export type { AuthoredTool, BuiltDefinition, Unfinished } from "./harnesses/assembly.ts";
export type { HarnessSelection } from "./harnesses/config.ts";
export type { CodingToolName, HarnessName, SandboxMode } from "./harnesses/define.ts";
export type { AgentCommand } from "./harnesses/text.ts";

/** Closable storage handle opened in phase 1 before MCP clients start. */
export interface HarnessStorageHandle {
  close(): Promise<void> | void;
}

/** Live runtime agent returned by phase 2 (`openAgent`) and managed by `openServing`. */
export interface HarnessRuntimeAgent extends Agent {
  busy(): boolean;
  close(): Promise<void>;
  /** Optional promise resolving if the underlying runtime closes on its own (e.g. fatal storage error). */
  readonly closed?: Promise<void>;
  /** Optional synchronous notification fired when internal runtime shutdown starts. */
  subscribeClose?(listener: () => void): () => void;
}

/** Resolved location and optional database identity of an instance's durable storage. */
export interface HarnessInstancePlace {
  readonly stateRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name?: string;
  readonly agent?: string;
  readonly database?: PostgresDatabase;
}

/** Storage mode requested when opening an instance. */
export type HarnessStorageTarget = "instance" | { readonly file: string; readonly holders?: string } | "memory";

/** Phase-1 context passed to `HarnessProvider.openStorage` before spawning MCP servers. */
export interface HarnessStorageOpenContext {
  readonly place: HarnessInstancePlace;
  readonly chosen: HarnessStorageTarget;
  readonly database: SharedPostgresDatabase | undefined;
  readonly onLost: (error: Error) => void;
  readonly handoff: PgLeaseHandoff;
}

/** Agent identity and starter prompts reported by `info()`. */
export interface HarnessAgentPresentation {
  readonly agent: { readonly name: string; readonly description?: string };
  readonly starters?: readonly string[];
}

/** Minimal structural telemetry span compatible with `@earendil-works/pi-telemetry`. */
export interface HarnessTelemetrySpan {
  startSpan<T>(
    options: {
      readonly name: string;
      readonly attributes?: Readonly<
        Record<
          string,
          string | number | boolean | readonly string[] | readonly number[] | readonly boolean[] | undefined
        >
      >;
    },
    callback: (span: HarnessTelemetrySpan) => T | Promise<T>,
  ): Promise<T>;
  setAttributes(
    attributes: Readonly<
      Record<string, string | number | boolean | readonly string[] | readonly number[] | readonly boolean[] | undefined>
    >,
  ): void;
  setStatus(
    status:
      | { readonly status: "ok" }
      | { readonly status: "error"; readonly error?: { readonly name: string; readonly message: string } },
  ): void;
}

/** Minimal structural telemetry context compatible with `@earendil-works/pi-telemetry`. */
export interface HarnessTelemetryContext {
  startSpan<T>(
    options: {
      readonly name: string;
      readonly attributes?: Readonly<
        Record<
          string,
          string | number | boolean | readonly string[] | readonly number[] | readonly boolean[] | undefined
        >
      >;
    },
    callback: (span: HarnessTelemetrySpan) => T | Promise<T>,
  ): Promise<T>;
}

/** Phase-2 context passed to `HarnessProvider.openAgent` once storage and MCP clients are ready. */
export interface HarnessAgentOpenContext<S extends HarnessStorageHandle = HarnessStorageHandle> {
  readonly storage: S;
  readonly definition: AgentDefinition;
  readonly code: BuiltDefinition;
  readonly mcpTools: readonly PortableTool[];
  readonly codingTools: readonly CodingToolName[];
  readonly presentation: HarnessAgentPresentation;
  readonly name: string;
  readonly workdir: string;
  readonly stateRoot: string;
  readonly selection: HarnessSelection;
  readonly processEnv: Readonly<Record<string, string>>;
  readonly models: Models;
  readonly model?: ModelRef;
  readonly unusableDefault?: NonNullable<AgentInfo["unusableDefault"]>;
  readonly runsAs: RunsAs;
  readonly unfinished?: Unfinished;
  readonly telemetry?: HarnessTelemetryContext;
  readonly work: WorkTracker;
  readonly commands: () => readonly AgentCommand[];
  readonly renderSystemPrompt: () => string | undefined;
}

/** Two-phase runtime harness plugin contract exported as `harnessProvider` from `@fastagent-sh/harness-<name>/provider`. */
export interface HarnessProvider<S extends HarnessStorageHandle = HarnessStorageHandle> {
  readonly name: string;
  /** Whether this harness installs `src/extensions/*` (`pi-durable` only; `false` logs a skip warning). */
  readonly supportsExtensions?: boolean;
  /** Whether this harness enforces OS sandboxing (`workspace` / `read-only` / `off`). */
  readonly supportsSandbox?: boolean;
  openStorage(ctx: HarnessStorageOpenContext): Promise<S> | S;
  openAgent(ctx: HarnessAgentOpenContext<S>): Promise<HarnessRuntimeAgent>;
}

/** Wrap an authored tool to fail visibly if it returns a `pi-durable`-only park (`sleep` / `wait`) on another harness. */
export function adaptToolRejectingPark(tool: AuthoredTool): AuthoredTool {
  return {
    ...tool,
    execute: async (args, api, context) => {
      const result = await tool.execute(args, api, context);
      if (result !== null && typeof result === "object" && ("sleep" in result || "wait" in result)) {
        throw new Error(
          `tool "${tool.name}" returned a park response (sleep/wait), which requires harness: "pi-durable"`,
        );
      }
      return result;
    },
  };
}

/** Closable single-consumer async queue used to bridge live session events into `AsyncIterable` streams. */
export interface EventChannelWatcher<T> {
  push(item: T): void;
  end(): void;
}

/** Create an in-memory async event channel that invokes `onClose` when the consumer detaches or completes. */
export function createEventChannel<T>(onClose: () => void): {
  readonly watcher: EventChannelWatcher<T>;
  readonly iterable: AsyncIterable<T>;
} {
  const queue: T[] = [];
  let closed = false;
  let notified = false;
  let waiting: ((result: IteratorResult<T>) => void) | undefined;

  const notifyClose = (): void => {
    if (notified) return;
    notified = true;
    onClose();
  };

  const watcher: EventChannelWatcher<T> = {
    push(item) {
      if (closed) return;
      if (waiting !== undefined) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ done: false, value: item });
      } else {
        queue.push(item);
      }
    },
    end() {
      if (closed) return;
      closed = true;
      if (waiting !== undefined) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ done: true, value: undefined });
      }
      notifyClose();
    },
  };

  async function* generate(): AsyncGenerator<T> {
    try {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift() as T;
          continue;
        }
        if (closed) return;
        const next = await new Promise<IteratorResult<T>>((resolve) => {
          waiting = resolve;
        });
        if (next.done) return;
        yield next.value;
      }
    } finally {
      closed = true;
      waiting = undefined;
      notifyClose();
    }
  }

  return { watcher, iterable: generate() };
}
