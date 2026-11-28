/**
 * Durable persistence & pure state projections for serving-layer human-in-the-loop interrupts
 * (`interrupts.sqlite`, PostgreSQL `fastagent_interrupts`, or in-memory).
 */
import { existsSync } from "node:fs";
import {
  type AgentErrorData,
  type ContentPart,
  type DecodedInterruptResolution,
  type Entry,
  type IdempotencyKey,
  type InterruptId,
  type InterruptKind,
  type Json,
  type Message,
  type MessageId,
  type MessageStatus,
  type Metadata,
  type PendingInterrupt,
  type QueuedMessage,
  type SendRequest,
  type Session,
  type SessionId,
  agentError,
} from "@fastagent-sh/client/agent-api";
import type { ToolApprovalDecision } from "./harnesses/tool.ts";
import { type SqliteStoreHandle, openPostgresStore, openSqliteStore } from "./instance-store.ts";
import type { PostgresDatabase } from "./postgres.ts";

export const CONTINUATION_HEADER = "[fastagent:interrupt-resume]";

export interface StoredInterruptItem {
  readonly interrupt: PendingInterrupt;
  readonly rawArgs: Json;
  readonly state:
    | { readonly status: "pending" }
    | { readonly status: "approved"; readonly key?: IdempotencyKey }
    | { readonly status: "denied"; readonly reason?: string; readonly key?: IdempotencyKey }
    | { readonly status: "submitted"; readonly input: Record<string, Json>; readonly key?: IdempotencyKey }
    | { readonly status: "canceled" };
}

export interface StoredInterruptMessage {
  readonly id: MessageId;
  readonly sessionId: SessionId;
  readonly idempotencyKey?: IdempotencyKey;
  readonly metadata?: Metadata;
  readonly entryId?: string;
  readonly phase: "parked" | "resuming" | "settled";
  readonly status: MessageStatus;
  readonly answer?: { readonly entryId: string; readonly text: string };
  readonly error?: AgentErrorData;
  readonly items: readonly StoredInterruptItem[];
  readonly activeInnerMessageId?: MessageId;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredQueuedSend {
  readonly id: MessageId;
  readonly request: SendRequest;
  readonly mode: "steer" | "queue";
  readonly createdAt: number;
}

export interface RewrittenToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly content: readonly ContentPart[];
  readonly details?: Json;
}

export interface SessionInterruptState {
  readonly sessionId: SessionId;
  readonly messages: Readonly<Record<string, StoredInterruptMessage>>;
  readonly activeMessageId?: MessageId;
  readonly queued: readonly StoredQueuedSend[];
  readonly resolvedKeys: Readonly<Record<string, { readonly key: IdempotencyKey; readonly messageId: MessageId }>>;
  readonly hiddenEntryIds: readonly string[];
  readonly rewrittenEntries: Readonly<Record<string, RewrittenToolResult>>;
}

export interface InterruptStore {
  list(): Promise<readonly SessionInterruptState[]>;
  get(sessionId: SessionId): Promise<SessionInterruptState | undefined>;
  put(state: SessionInterruptState): Promise<void>;
  delete(sessionId: SessionId): Promise<void>;
  close(): Promise<void>;
}

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fastagent_interrupts (
  session_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS fastagent_interrupts (
  instance   TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (instance, session_id)
);
`;

export function emptySessionState(sessionId: SessionId): SessionInterruptState {
  return {
    sessionId,
    messages: {},
    queued: [],
    resolvedKeys: {},
    hiddenEntryIds: [],
    rewrittenEntries: {},
  };
}

export function memoryInterruptStore(): InterruptStore {
  const rows = new Map<string, string>();
  return {
    async list() {
      return [...rows.values()].map((raw) => JSON.parse(raw) as SessionInterruptState);
    },
    async get(sessionId) {
      const raw = rows.get(sessionId);
      return raw === undefined ? undefined : (JSON.parse(raw) as SessionInterruptState);
    },
    async put(state) {
      rows.set(state.sessionId, JSON.stringify(state));
    },
    async delete(sessionId) {
      rows.delete(sessionId);
    },
    async close() {},
  };
}

export function sqliteInterruptStore(filePath: string): InterruptStore {
  let handle: SqliteStoreHandle | undefined;
  let closed = false;

  const ensureOpen = (): SqliteStoreHandle => {
    if (closed) throw agentError("unavailable", "Interrupt store is closed");
    handle ??= openSqliteStore(filePath, SQLITE_SCHEMA, { journalMode: "WAL" });
    return handle;
  };

  return {
    async list() {
      if (handle === undefined && !existsSync(filePath)) return [];
      const rows = ensureOpen().db.prepare("SELECT state_json FROM fastagent_interrupts").all() as Array<{
        state_json: string;
      }>;
      return rows.map((row) => JSON.parse(row.state_json) as SessionInterruptState);
    },
    async get(sessionId) {
      if (handle === undefined && !existsSync(filePath)) return undefined;
      const row = ensureOpen()
        .db.prepare("SELECT state_json FROM fastagent_interrupts WHERE session_id = ?")
        .get(sessionId) as { state_json: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.state_json) as SessionInterruptState);
    },
    async put(state) {
      ensureOpen()
        .db.prepare(
          `INSERT INTO fastagent_interrupts (session_id, state_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
        )
        .run(state.sessionId, JSON.stringify(state), Date.now());
    },
    async delete(sessionId) {
      if (handle === undefined && !existsSync(filePath)) return;
      ensureOpen().db.prepare("DELETE FROM fastagent_interrupts WHERE session_id = ?").run(sessionId);
    },
    async close() {
      closed = true;
      if (handle !== undefined) {
        const current = handle;
        handle = undefined;
        await current.close();
      }
    },
  };
}

export function postgresInterruptStore(database: PostgresDatabase, instanceName: string): InterruptStore {
  if (!instanceName) {
    throw new Error("postgresInterruptStore requires a non-empty instance name");
  }
  const pg = openPostgresStore(database, PG_SCHEMA, "Interrupt store");

  return {
    async list() {
      const rows = await pg.queryIfExists<{ state_json: string }>(
        "SELECT state_json FROM fastagent_interrupts WHERE instance = $1",
        [instanceName],
      );
      return (rows ?? []).map((row) => JSON.parse(row.state_json) as SessionInterruptState);
    },
    async get(sessionId) {
      const rows = await pg.queryIfExists<{ state_json: string }>(
        "SELECT state_json FROM fastagent_interrupts WHERE instance = $1 AND session_id = $2",
        [instanceName, sessionId],
      );
      const first = rows?.[0];
      return first === undefined ? undefined : (JSON.parse(first.state_json) as SessionInterruptState);
    },
    async put(state) {
      await pg.query(
        `INSERT INTO fastagent_interrupts (instance, session_id, state_json, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (instance, session_id) DO UPDATE
         SET state_json = EXCLUDED.state_json, updated_at = EXCLUDED.updated_at`,
        [instanceName, state.sessionId, JSON.stringify(state), Date.now()],
      );
    },
    async delete(sessionId) {
      await pg.queryIfExists("DELETE FROM fastagent_interrupts WHERE instance = $1 AND session_id = $2", [
        instanceName,
        sessionId,
      ]);
    },
    close: () => pg.close(),
  };
}

export interface StagedInterruptItem {
  readonly id: InterruptId;
  readonly kind: InterruptKind;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly args?: Json;
  readonly inputSchema?: Record<string, Json>;
  readonly rawArgs: Json;
  readonly createdAt: number;
}

function pendingInterruptsOf(items: readonly StoredInterruptItem[]): PendingInterrupt[] {
  return items.flatMap((item) => (item.state.status === "pending" ? [item.interrupt] : []));
}

export function parkedStatusOf(items: readonly StoredInterruptItem[]): "awaiting_approval" | "input_required" {
  const pending = pendingInterruptsOf(items);
  return pending.some((item) => item.kind === "approval") ? "awaiting_approval" : "input_required";
}

export function toPublicInterruptMessage(stored: StoredInterruptMessage): Message {
  const pending = pendingInterruptsOf(stored.items);
  return {
    id: stored.id,
    sessionId: stored.sessionId,
    ...(stored.idempotencyKey === undefined ? {} : { idempotencyKey: stored.idempotencyKey }),
    ...(stored.metadata === undefined ? {} : { metadata: stored.metadata }),
    status: stored.status,
    ...(stored.entryId === undefined ? {} : { entryId: stored.entryId }),
    ...(pending.length > 0 ? { interrupts: pending } : {}),
    ...(stored.answer === undefined ? {} : { answer: stored.answer }),
    ...(stored.error === undefined ? {} : { error: stored.error }),
  };
}

export function normalizeApprovalDecision(
  toolName: string,
  decision: ToolApprovalDecision,
  parsedArgs: unknown,
): { required: false } | { required: true; summary: string; args?: Json } {
  if (decision === false) return { required: false };
  if (decision === true) return { required: true, summary: `Approve tool "${toolName}"` };
  if (typeof decision === "string") {
    return { required: true, summary: decision.trim() || `Approve tool "${toolName}"` };
  }
  const summary = decision.summary?.trim() || `Approve tool "${toolName}"`;
  return {
    required: true,
    summary,
    ...(decision.includeArgs ? { args: structuredClone(parsedArgs) as Json } : {}),
  };
}

function validateJsonSchemaType(expectedType: unknown, actual: unknown): boolean {
  switch (expectedType) {
    case "string":
      return typeof actual === "string";
    case "number":
      return typeof actual === "number" && Number.isFinite(actual);
    case "integer":
      return typeof actual === "number" && Number.isInteger(actual);
    case "boolean":
      return typeof actual === "boolean";
    case "null":
      return actual === null;
    case "array":
      return Array.isArray(actual);
    case "object":
      return typeof actual === "object" && actual !== null && !Array.isArray(actual);
    default:
      return true;
  }
}

function validateSubmittedInputAgainstJsonSchema(
  schema: Record<string, Json> | undefined,
  input: Record<string, Json>,
): string | undefined {
  if (schema === undefined) return undefined;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === "string")
    : [];
  for (const key of required) {
    if (!(key in input) || input[key] === undefined) {
      return `missing required field "${key}"`;
    }
  }
  const properties =
    typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : undefined;
  if (properties !== undefined) {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in input) || input[key] === undefined) continue;
      const value = input[key];
      if (propSchema.type !== undefined && !validateJsonSchemaType(propSchema.type, value)) {
        return `field "${key}" must be of type ${String(propSchema.type)}`;
      }
      if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(value)) {
        return `field "${key}" must be one of (${propSchema.enum.map((v) => JSON.stringify(v)).join(", ")})`;
      }
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(input).find((k) => !(k in properties));
      if (extra !== undefined) return `unexpected field "${extra}"`;
    }
  }
  return undefined;
}

export function validateResolutionPayload(item: StoredInterruptItem, resolution: DecodedInterruptResolution): void {
  const { kind, inputSchema, id } = item.interrupt;
  if (kind === "approval" && resolution.action === "submit") {
    throw agentError("invalid_request", `Interrupt ${id} is a tool approval: pass action "approve" or "deny"`);
  }
  if (kind === "input" && resolution.action === "approve") {
    throw agentError(
      "invalid_request",
      `Interrupt ${id} requires structured input: pass action "submit" with input (or "deny")`,
    );
  }
  if (resolution.action === "submit") {
    const schemaProblem = validateSubmittedInputAgainstJsonSchema(inputSchema, resolution.input);
    if (schemaProblem !== undefined) {
      throw agentError("invalid_request", `Invalid input for interrupt ${id}: ${schemaProblem}`);
    }
  }
}

export function formatContinuationPrompt(outcomes: readonly RewrittenToolResult[]): string {
  const sections = outcomes.map((outcome) => {
    const text = outcome.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    return [
      CONTINUATION_HEADER,
      `toolCallId: ${outcome.toolCallId}`,
      `toolName: ${outcome.toolName}`,
      `status: ${outcome.isError ? "error" : "ok"}`,
      "output:",
      text,
    ].join("\n");
  });
  return sections.join("\n---\n");
}

export function applyEntryProjection(entry: Entry, state: SessionInterruptState | undefined): Entry | undefined {
  if (state === undefined) return entry;
  if (state.hiddenEntryIds.includes(entry.id)) return undefined;
  const rewritten = state.rewrittenEntries[entry.id];
  if (rewritten !== undefined) {
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      kind: "tool_result",
      data: {
        toolCallId: rewritten.toolCallId,
        toolName: rewritten.toolName,
        isError: rewritten.isError,
        content: rewritten.content.map((part) => ({ ...part })),
        ...(rewritten.details === undefined ? {} : { details: rewritten.details }),
      },
    };
  }
  return entry;
}

export function overlaySession(raw: Session, state: SessionInterruptState | undefined): Session {
  if (state === undefined) return raw;
  const active = state.activeMessageId === undefined ? undefined : state.messages[state.activeMessageId];
  const queuedExtras: QueuedMessage[] = state.queued.map((q) => ({ id: q.id, mode: q.mode }));
  const mergedQueued = [...(raw.queuedMessages ?? []), ...queuedExtras];
  if (active === undefined) {
    if (queuedExtras.length === 0) return raw;
    return { ...raw, queuedMessages: mergedQueued };
  }
  const pending = pendingInterruptsOf(active.items);
  const status = active.phase === "parked" ? parkedStatusOf(active.items) : "running";
  const { reply: _reply, activeTools: _tools, interrupts: _prevInt, queuedMessages: _prevQueued, ...base } = raw;
  return {
    ...base,
    status,
    ...(active.phase === "resuming" && raw.reply !== undefined ? { reply: raw.reply } : {}),
    ...(active.phase === "resuming" && raw.activeTools !== undefined ? { activeTools: raw.activeTools } : {}),
    ...(pending.length > 0 ? { interrupts: pending } : {}),
    ...(mergedQueued.length > 0 ? { queuedMessages: mergedQueued } : {}),
  };
}
