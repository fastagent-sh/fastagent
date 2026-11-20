/**
 * Public types for the experimental `@fastagent-sh/harness-dsh` adapter.
 * Keeps all `@deepseek-ai/*` runtime dependencies optional so hosts pay for DSH only when selecting it.
 */
import type { Agent, ModelRef, ThinkingLevel } from "@fastagent-sh/client/agent-api";

/** OS sandbox posture for DSH filesystem and shell tools. */
export type DshSandboxMode = "off" | "workspace" | "read-only";

/** Fail-closed OS sandbox policy passed to DSH's `LocalSandboxProvider`. */
export interface DshSandboxPolicy {
  readonly workspace: string;
  readonly writablePaths: readonly string[];
  readonly readablePaths: readonly string[];
  readonly network: "none" | "allow";
}

/** Opaque persisted DSH session header stored alongside the append-only event log. */
export interface DshSessionHeader {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly isSeeded: boolean;
  readonly origin?: "subagent";
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

/** Contiguous event record stored in a DSH session log. */
export interface DshSessionEvent {
  readonly seq: number;
  readonly type: string;
  readonly timestamp?: number;
  readonly data?: unknown;
}

/** Lightweight metadata snapshot returned by `stat()` / `list()` without loading the event log. */
export interface DshSessionSnapshot {
  readonly header: DshSessionHeader;
  readonly revision: string;
  readonly eventCount: number;
}

/** Open single-session handle matching `@deepseek-ai/dsh-session-persistence`'s `SessionHandle` contract. */
export interface DshSessionHandle extends AsyncDisposable {
  readonly id: string;
  readonly access: "read" | "write";
  readonly header: DshSessionHeader;
  readonly inheritedEventCount: number;
  readonly closed: boolean;
  read(
    offset?: number,
    length?: number,
  ): Promise<{ readonly events: readonly DshSessionEvent[]; readonly eventState: "detached" }>;
  append(events: readonly DshSessionEvent[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Storage backend backing DSH's `SessionPersistence` service (in-memory for tests, SQLite or PostgreSQL for
 * production). Enforces single-writer ownership per session and contiguous sequence numbers starting at 0.
 */
export interface DshEventStoreBackend {
  create(header: DshSessionHeader, options?: { readonly inheritedEventCount?: number }): Promise<DshSessionHandle>;
  open(id: string, access: "read" | "write"): Promise<DshSessionHandle>;
  flush(): Promise<void>;
  stat(id: string): Promise<DshSessionSnapshot | undefined>;
  list(): Promise<readonly DshSessionSnapshot[]>;
}

/** Minimal tool shape produced by `defineTool` from `@fastagent-sh/fastagent` (or `@earendil-works/pi-durable`). */
export interface FastAgentToolLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
  execute(
    args: never,
    api: never,
    context: never,
  ): Promise<{
    readonly output?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly isError?: boolean;
  }>;
}

/** Tool definition shape expected by `@deepseek-ai/dsh-tools`'s `ctx.tools.register()`. */
export interface DshToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    readonly render: (value: unknown) => Array<{ readonly type: "text"; readonly text: string }>;
  };
  execute(
    args: unknown,
    exec: { readonly signal: AbortSignal },
  ): Promise<{ readonly text: string; readonly isError?: boolean }>;
}

/** Options for opening an agent over the experimental DSH harness. */
export interface DshHarnessOptions {
  /** Instance name reported by `info().name`. */
  readonly name: string;
  /** Absolute working directory for the agent instance. */
  readonly workdir: string;
  /** System prompt text (from `SYSTEM.md` / `AGENTS.md`). */
  readonly systemPrompt?: string;
  /** Default model selection (`provider` + `modelId`). */
  readonly model?: ModelRef;
  readonly thinkingLevel?: ThinkingLevel;
  /** Portable FastAgent tools to bridge into DSH's `ToolsService`. */
  readonly tools?: readonly FastAgentToolLike[];
  /** OS sandbox posture for local shell/filesystem tools. Default: `"workspace"`. */
  readonly sandbox?: DshSandboxMode;
  /** Allow outbound network inside sandboxed shell commands. Default: `false`. */
  readonly sandboxNetwork?: boolean;
  /** Event log storage backend. Defaults to in-memory storage when omitted. */
  readonly storage?: DshEventStoreBackend;
}

/** Agent opened on the DSH harness: pure Agent API plus lifecycle teardown. */
export interface DshAgent extends Agent {
  close(): Promise<void>;
}
