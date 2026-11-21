/**
 * Public types for the experimental `@fastagent-sh/harness-dsh` adapter.
 * Keeps all `@deepseek-ai/*` runtime dependencies optional so hosts pay for DSH only when selecting it.
 */
import type { Models } from "@earendil-works/pi-ai";
import type {
  Agent,
  AgentErrorData,
  ContentPart,
  Metadata,
  ModelRef,
  ThinkingLevel,
  Usage,
} from "@fastagent-sh/client/agent-api";

/** OS sandbox posture for DSH filesystem and shell tools. */
export type DshSandboxMode = "off" | "workspace" | "read-only";

/** Built-in sandboxed coding tool names matching FastAgent's `codingTools` config. */
export type DshCodingToolName = "read" | "write" | "edit" | "bash";

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
  readonly surfaceOp?: unknown;
  readonly sourceEventSeqs?: readonly number[];
  readonly ignorable?: boolean;
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

/** Durable session metadata stored alongside the DSH event log. */
export interface DshStoredSession {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly order: number;
  readonly deleted: boolean;
  readonly title?: string;
  readonly model?: ModelRef;
  readonly thinkingLevel?: ThinkingLevel;
  readonly instructions?: string;
  readonly tools?: readonly string[];
  readonly inheritedEntryCount: number;
  readonly inheritedContextUsage?: { readonly tokens: number; readonly contextWindow?: number };
  readonly usage: Usage;
}

/** Durable message ledger row tracking FastAgent's per-message lifecycle. */
export interface DshStoredMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly idempotencyKey?: string;
  readonly metadata?: Metadata;
  readonly status: "queued" | "running" | "completed" | "incomplete" | "failed" | "canceled";
  readonly whenBusy: "queue" | "steer" | "reject";
  /** The verbatim user content stored on the user entry (with image refs). */
  readonly displayContent: readonly ContentPart[];
  /** The expanded text/content fed to the model (after command expansion). */
  readonly modelContent: readonly ContentPart[];
  readonly entryId?: string;
  readonly answer?: { readonly entryId: string; readonly text: string };
  readonly error?: AgentErrorData;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Durable binary attachment (e.g. image) stored per session. */
export interface DshStoredAttachment {
  readonly ref: string;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
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
  /** Optional durable ledger methods (implemented by MemoryDshEventStore and Phase 2 SQL/Postgres backends). */
  getSessionMeta?(id: string): Promise<DshStoredSession | undefined>;
  putSessionMeta?(session: DshStoredSession): Promise<void>;
  listSessionMetas?(): Promise<readonly DshStoredSession[]>;
  getMessage?(sessionId: string, messageId: string): Promise<DshStoredMessage | undefined>;
  getMessageByKey?(sessionId: string, idempotencyKey: string): Promise<DshStoredMessage | undefined>;
  putMessage?(message: DshStoredMessage): Promise<void>;
  listMessages?(sessionId?: string): Promise<readonly DshStoredMessage[]>;
  putAttachment?(attachment: DshStoredAttachment): Promise<void>;
  getAttachment?(sessionId: string, ref: string): Promise<DshStoredAttachment | undefined>;
}

/** Runtime helper object passed to FastAgent tools (`defineTool`). */
export interface FastAgentToolApi {
  output?(chunk: string): void;
  executeTool?(name: string, args: unknown, context?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
}

/** Minimal tool shape produced by `defineTool` from `@fastagent-sh/fastagent` (or `@earendil-works/pi-durable`). */
export interface FastAgentToolLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
  readonly outputLimits?: { readonly maxBytes?: number; readonly retain?: "head" | "tail" };
  execute(
    args: never,
    api: never,
    context: never,
  ): Promise<{
    readonly output?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly details?: unknown;
    readonly isError?: boolean;
    readonly control?: { readonly terminate?: boolean };
  }>;
}

/** Tool definition shape expected by `@deepseek-ai/dsh-tools`'s `ctx.tools.register()`. */
export interface DshToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    readonly render: (args: unknown, value: unknown) => Array<{ readonly type: "text"; readonly text: string }>;
    readonly presentationMeta?: (args: unknown, value: unknown) => unknown;
  };
  execute(
    args: unknown,
    exec: { readonly signal: AbortSignal; readonly callId?: string; concludeTurn?(): void },
  ): Promise<{ readonly text: string; readonly isError?: boolean; readonly details?: unknown }>;
}

/** Slash command advertised by `info().commands` and expanded before reaching the model. */
export interface DshCommand {
  readonly name: string;
  readonly description?: string;
  expand(args: string): string;
}

/** Retry policy for transient model call failures. */
export interface DshRetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
}

/** Options for opening an agent over the experimental DSH harness. */
export interface DshHarnessOptions {
  /** Instance name reported by `info().name`. */
  readonly name: string;
  /** Program identity reported by `info().agent`. */
  readonly agent?: { readonly name: string; readonly description?: string };
  /** Example starter prompts reported by `info().starters`. */
  readonly starters?: readonly string[];
  /** Absolute working directory for the agent instance. */
  readonly workdir: string;
  /** System prompt text (from `SYSTEM.md` / `AGENTS.md`). */
  readonly systemPrompt?: string;
  /** Model registry (`@earendil-works/pi-ai`) supplying providers, auth, and streaming. */
  readonly models?: Models;
  /** Default model selection (`provider` + `modelId`). */
  readonly model?: ModelRef;
  readonly thinkingLevel?: ThinkingLevel;
  /** Portable FastAgent tools to bridge into DSH's `ToolsService`. */
  readonly tools?: readonly FastAgentToolLike[];
  /** Built-in sandboxed coding tools (`read`, `write`, `edit`, `bash`). Default: `false`. */
  readonly codingTools?: boolean | readonly DshCodingToolName[];
  /** Slash commands offered by `info().commands`. */
  readonly commands?: () => readonly DshCommand[];
  /** Hook invoked when a session is deleted (e.g. to clear external clock wakeups). */
  readonly onSessionDelete?: (sessionId: string) => void | Promise<void>;
  /** Retry policy for transient model failures. */
  readonly retry?: DshRetryOptions;
  /** OS sandbox posture for local shell/filesystem tools. Default: `"workspace"`. */
  readonly sandbox?: DshSandboxMode;
  /** Allow outbound network inside sandboxed shell commands. Default: `false`. */
  readonly sandboxNetwork?: boolean;
  /** Event log + ledger storage backend. Defaults to in-memory storage when omitted. */
  readonly storage?: DshEventStoreBackend;
}

/** Agent opened on the DSH harness: pure Agent API plus lifecycle teardown. */
export interface DshAgent extends Agent {
  close(): Promise<void>;
}
