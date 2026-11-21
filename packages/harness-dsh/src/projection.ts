/**
 * Pure projection from DSH `SessionEvent` logs to FastAgent `Entry`, cursor pagination,
 * `Usage` / `ContextUsage` derivation, and `AgentErrorData` classification.
 */
import type { ContentBlock, LlmFailure, TokenUsage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { Models } from "@earendil-works/pi-ai";
import {
  type AgentErrorData,
  type ContentPart,
  type ContextUsage,
  type EntriesOptions,
  type Entry,
  type Json,
  type Message,
  type Page,
  type Tokens,
  type Usage,
  agentError,
} from "@fastagent-sh/client/agent-api";
import type { DshStoredMessage } from "./types.ts";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "fastagent-user": {
      readonly kind: "fastagent-user";
      readonly messageId: string;
      readonly displayContent: readonly ContentPart[];
    };
    "fastagent-compaction": {
      readonly kind: "fastagent-compaction";
      readonly summary: string;
    };
    "fastagent-recovery": {
      readonly kind: "fastagent-recovery";
      readonly messageId: string;
    };
  }
}

const entryIdForSeq = (seq: number): string => `e_${seq}`;

export function seqForEntryId(entryId: string): number | undefined {
  if (!entryId.startsWith("e_")) return undefined;
  const parsed = Number(entryId.slice(2));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function emptyUsage(): Usage {
  return { models: {}, tools: {} };
}

export function addTokens(target: Record<string, Tokens>, key: string, delta: Tokens): void {
  const existing = target[key];
  if (existing === undefined) {
    target[key] = { ...delta };
    return;
  }
  const cacheReadTokens = (existing.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0);
  const cacheWriteTokens = (existing.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0);
  const cost = (existing.cost ?? 0) + (delta.cost ?? 0);
  target[key] = {
    inputTokens: existing.inputTokens + delta.inputTokens,
    outputTokens: existing.outputTokens + delta.outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(cost > 0 ? { cost } : {}),
  };
}

export function mergeUsages(usages: readonly Usage[]): Usage {
  const out = emptyUsage();
  for (const usage of usages) {
    for (const [model, tokens] of Object.entries(usage.models)) addTokens(out.models, model, tokens);
    for (const [tool, tokens] of Object.entries(usage.tools)) addTokens(out.tools, tool, tokens);
  }
  return out;
}

function toFastAgentTokens(usage: TokenUsage | undefined, cost?: number): Tokens {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    ...(usage?.cacheReadTokens !== undefined && usage.cacheReadTokens > 0
      ? { cacheReadTokens: usage.cacheReadTokens }
      : {}),
    ...(usage?.cacheWriteTokens !== undefined && usage.cacheWriteTokens > 0
      ? { cacheWriteTokens: usage.cacheWriteTokens }
      : {}),
    ...(cost !== undefined && cost > 0 ? { cost } : {}),
  };
}

function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function blocksToThinking(blocks: readonly ContentBlock[]): string | undefined {
  const thinking = blocks.flatMap((block) => (block.type === "reasoning" ? [block.text] : [])).join("");
  return thinking.length > 0 ? thinking : undefined;
}

function parseJsonArgs(raw: string): Json {
  try {
    return JSON.parse(raw || "{}") as Json;
  } catch {
    return {} as Json;
  }
}

function extractFinishStop(stream: readonly unknown[]): "max_tokens" | "failed" | "aborted" | undefined {
  for (let i = stream.length - 1; i >= 0; i--) {
    const rec = stream[i] as { type?: string; chunk?: { type?: string; reason?: { kind?: string } } } | undefined;
    if (rec?.type === "chunk" && rec.chunk?.type === "finish") {
      const kind = rec.chunk.reason?.kind;
      if (kind === "max-tokens") return "max_tokens";
      if (kind === "aborted") return "aborted";
      if (kind === "error") return "failed";
      return undefined;
    }
  }
  return undefined;
}

export interface ProjectedEntryResult {
  readonly entry: Entry;
  readonly seq: number;
  readonly messageId?: string;
  readonly hasToolCalls?: boolean;
  readonly assistantText?: string;
  readonly stop?: "max_tokens" | "failed" | "aborted";
  readonly modelKey?: string;
  readonly tokens?: Tokens;
}

/**
 * Project one DSH `SessionEvent` into a FastAgent `Entry`, or `undefined` for internal lifecycle events.
 */
export function projectSessionEvent(
  event: SessionEvent,
  toolNamesByCallId: Map<string, string>,
  costBySeq?: ReadonlyMap<number, number>,
): ProjectedEntryResult | undefined {
  const id = entryIdForSeq(event.seq);
  const timestamp = event.time;

  if (event.type === "user/message") {
    const msg = event.data;
    if (msg.source.kind === "fastagent-recovery") return undefined;
    if (msg.source.kind === "fastagent-compaction") {
      return {
        seq: event.seq,
        entry: {
          id,
          timestamp,
          kind: "compaction",
          data: { summary: msg.source.summary } as unknown as Json,
        },
      };
    }
    if (msg.source.kind === "fastagent-user") {
      return {
        seq: event.seq,
        messageId: msg.source.messageId,
        entry: {
          id,
          timestamp,
          kind: "user",
          data: {
            content: structuredClone(msg.source.displayContent),
            messageId: msg.source.messageId,
          } as unknown as Json,
        },
      };
    }
    const text = blocksToText(msg.content);
    return {
      seq: event.seq,
      entry: {
        id,
        timestamp,
        kind: "user",
        data: { content: [{ type: "text", text }] } as unknown as Json,
      },
    };
  }

  if (event.type === "assistant/message") {
    const payload = event.data;
    const text = blocksToText(payload.message.content);
    const thinking = blocksToThinking(payload.message.content);
    const toolCalls = payload.message.content.flatMap((block) => {
      if (block.type !== "tool-call") return [];
      toolNamesByCallId.set(block.id, block.name);
      return [{ id: block.id, name: block.name, args: parseJsonArgs(block.arguments) }];
    });
    const stop = payload.interrupted ? "aborted" : extractFinishStop(payload.stream);
    const modelKey = `${payload.message.source.provider}/${payload.message.source.model}`;
    const tokens = toFastAgentTokens(payload.usage, costBySeq?.get(event.seq));
    const data: Record<string, unknown> = {
      text,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(stop !== undefined ? { stop } : {}),
      usage: tokens,
    };
    return {
      seq: event.seq,
      hasToolCalls: toolCalls.length > 0,
      assistantText: text,
      ...(stop !== undefined ? { stop } : {}),
      modelKey,
      tokens,
      entry: {
        id,
        timestamp,
        kind: "assistant",
        data: data as Json,
      },
    };
  }

  if (event.type === "tool/result") {
    const payload = event.data;
    const toolCallId = payload.message.toolCallId;
    const toolName = toolNamesByCallId.get(toolCallId) ?? "tool";
    const text = blocksToText(payload.message.content);
    const hasDetails = payload.meta !== undefined && payload.meta !== null;
    const data: Record<string, unknown> = {
      toolCallId,
      toolName,
      isError: payload.message.isError === true,
      content: text.length > 0 ? [{ type: "text", text }] : [],
      ...(hasDetails ? { details: structuredClone(payload.meta) } : {}),
    };
    return {
      seq: event.seq,
      entry: {
        id,
        timestamp,
        kind: "tool_result",
        data: data as Json,
      },
    };
  }

  return undefined;
}

/**
 * Project a full DSH event log into FastAgent entries.
 */
export function projectSessionLog(
  events: readonly SessionEvent[],
  costBySeq?: ReadonlyMap<number, number>,
): ProjectedEntryResult[] {
  const toolNamesByCallId = new Map<string, string>();
  const out: ProjectedEntryResult[] = [];
  for (const event of events) {
    const projected = projectSessionEvent(event, toolNamesByCallId, costBySeq);
    if (projected !== undefined) out.push(projected);
  }
  return out;
}

/**
 * Derive current context usage from the latest assistant/message after the latest compaction.
 */
export function deriveContextUsage(
  events: readonly SessionEvent[],
  models: Models | undefined,
  fallback?: ContextUsage,
): ContextUsage | undefined {
  let lastCompactionIdx = -1;
  let lastAssistantIdx = -1;
  let lastAssistantEvent: Extract<SessionEvent, { type: "assistant/message" }> | undefined;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type === "user/message" && event.data.source.kind === "fastagent-compaction") {
      lastCompactionIdx = i;
    } else if (event.type === "assistant/message" && event.data.usage !== undefined) {
      lastAssistantIdx = i;
      lastAssistantEvent = event;
    }
  }

  if (lastCompactionIdx > lastAssistantIdx) return undefined;
  if (lastAssistantEvent === undefined || lastAssistantEvent.data.usage === undefined) return fallback;

  const u = lastAssistantEvent.data.usage;
  const tokens = u.totalTokens ?? u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  if (tokens <= 0) return fallback;
  const resolvedModel = models?.getModel(
    lastAssistantEvent.data.message.source.provider,
    lastAssistantEvent.data.message.source.model,
  );
  return {
    tokens,
    ...(resolvedModel?.contextWindow !== undefined ? { contextWindow: resolvedModel.contextWindow } : {}),
  };
}

/**
 * Cursor pagination over projected entries matching `agent-api-conformance.ts`.
 */
export function paginateEntries(entries: readonly Entry[], options: EntriesOptions = {}): Page<Entry> {
  if (options.after !== undefined && options.before !== undefined) {
    throw agentError("invalid_request", "entries accepts either after or before, not both");
  }
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw agentError("invalid_request", `limit must be an integer between 1 and 500, got ${String(limit)}`);
  }

  if (options.after !== undefined) {
    const idx = entries.findIndex((entry) => entry.id === options.after);
    if (idx === -1) throw agentError("not_found", `unknown entry cursor "${options.after}"`);
    const start = idx + 1;
    const slice = entries.slice(start, start + limit);
    const hasPrev = start > 0 && slice.length > 0;
    const hasNext = start + slice.length < entries.length;
    return {
      data: slice,
      ...(hasPrev && slice[0] !== undefined ? { prev: slice[0].id } : {}),
      ...(hasNext && slice.at(-1) !== undefined ? { next: slice.at(-1)?.id } : {}),
    };
  }

  if (options.before !== undefined) {
    const idx = entries.findIndex((entry) => entry.id === options.before);
    if (idx === -1) throw agentError("not_found", `unknown entry cursor "${options.before}"`);
    const start = Math.max(0, idx - limit);
    const slice = entries.slice(start, idx);
    const hasPrev = start > 0 && slice.length > 0;
    const hasNext = idx < entries.length && slice.length > 0;
    return {
      data: slice,
      ...(hasPrev && slice[0] !== undefined ? { prev: slice[0].id } : {}),
      ...(hasNext && slice.at(-1) !== undefined ? { next: slice.at(-1)?.id } : {}),
    };
  }

  const start = Math.max(0, entries.length - limit);
  const slice = entries.slice(start);
  const hasPrev = start > 0 && slice.length > 0;
  return {
    data: slice,
    ...(hasPrev && slice[0] !== undefined ? { prev: slice[0].id } : {}),
  };
}

/** Convert a durable ledger message into the public Agent API `Message`. */
export function toPublicMessage(stored: DshStoredMessage): Message {
  return {
    id: stored.id,
    sessionId: stored.sessionId,
    ...(stored.idempotencyKey !== undefined ? { idempotencyKey: stored.idempotencyKey } : {}),
    ...(stored.metadata !== undefined ? { metadata: stored.metadata } : {}),
    status: stored.status,
    ...(stored.entryId !== undefined ? { entryId: stored.entryId } : {}),
    ...(stored.answer !== undefined ? { answer: stored.answer } : {}),
    ...(stored.error !== undefined ? { error: stored.error } : {}),
  };
}

/** Classify a DSH `LlmFailure` into FastAgent's `AgentErrorData`. */
export function classifyLlmFailure(failure: LlmFailure): AgentErrorData {
  if (failure.code === "AUTH") {
    return { code: "auth_required", message: failure.message, retryable: false };
  }
  if (failure.code === "UNKNOWN_MODEL") {
    return { code: "missing_model", message: failure.message, retryable: false };
  }
  const retryable =
    failure.code === "RATE_LIMIT" || failure.code === "SERVER" || failure.status === 429 || failure.status === 503;
  return {
    code: "model_error",
    message: failure.message,
    retryable,
  };
}
