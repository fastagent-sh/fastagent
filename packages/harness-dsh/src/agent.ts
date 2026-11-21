/**
 * Live FastAgent runtime over DeepSeek Harness (`@deepseek-ai/dsh`).
 * Hosts an isolated Cordis `Context` with 9 core DSH plugins, bridges FastAgent tools and `@earendil-works/pi-ai`
 * models, maintains the per-message admission ledger, and projects DSH events onto the Agent API.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import {
  type Agent as DshLoopAgent,
  type AgentHandle,
  type AgentOptions,
  AgentRegistry,
  type AssistantStreamFrame,
} from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { type ContentBlock, LlmRuntime, type ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  type SessionEvent as DshSessionEventRecord,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  SessionStore,
  buildForkSeed,
} from "@deepseek-ai/dsh-session";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { NativeToolExecutor } from "@deepseek-ai/dsh-tool-executor-native";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import {
  type ActiveTool,
  AgentError,
  type AgentErrorData,
  type AgentInfo,
  type ContentPart,
  type CreateSessionOptions,
  type EntriesOptions,
  type Entry,
  type ListOptions,
  type Message,
  type MessageKey,
  type MessageStreamEvent,
  type Metadata,
  type ModelRef,
  type Page,
  type QueuedMessage,
  type SendRequest,
  type Session,
  type SessionChanges,
  type SessionEvent,
  type ThinkingLevel,
  type Usage,
  agentError,
  hasEnded,
} from "@fastagent-sh/client/agent-api";
import { buildCodingTools, resolveEnabledCodingTools } from "./coding-tools.ts";
import { IMAGE_REF_PREFIX, PiAiModelsAdapter } from "./llm-pi-ai.ts";
import { MemoryDshEventStore, createDshPersistencePlugin } from "./persistence.ts";
import {
  addTokens,
  classifyLlmFailure,
  deriveContextUsage,
  emptyUsage,
  mergeUsages,
  paginateEntries,
  projectSessionEvent,
  projectSessionLog,
  seqForEntryId,
  toPublicMessage,
} from "./projection.ts";
import { buildDshSandboxPolicy } from "./sandbox.ts";
import { leavableIterator, messageStream } from "./stream.ts";
import { bridgeDshRuntimeTool, toDshToolDefinition } from "./tools.ts";
import type {
  DshAgent,
  DshCommand,
  DshEventStoreBackend,
  DshHarnessOptions,
  DshStoredMessage,
  DshStoredSession,
  FastAgentToolLike,
} from "./types.ts";

const VALID_THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

interface SequencedEvent {
  readonly seq: number;
  readonly event: SessionEvent;
}

interface Watcher {
  push(item: SequencedEvent): void;
  end(): void;
}

interface Waiter {
  resolve(message: Message): void;
  reject(error: unknown): void;
}

interface LiveSession {
  meta: DshStoredSession;
  dshAgent?: DshLoopAgent;
  dshHandle?: AgentHandle;
  instructionsDisposer?: () => void;
  toolsDisposer?: () => void;
  watchers: Set<Watcher>;
  waiters: Map<string, Set<Waiter>>;
  eventSeq: number;
  pendingSettlement?: Promise<void>;
  bufferedEvents: SessionEvent[];
  storageErrored: boolean;
  toolNamesByCallId: Map<string, string>;
  costBySeq: Map<number, number>;
  pendingCosts: number[];
  liveReply: { active: boolean; text: string; thinking: string };
  activeTools: Map<string, ActiveTool>;
  activeTurnMessageIds: string[];
  queuedMessages: QueuedMessage[];
  lastAnswerInTurn?: { readonly entryId: string; readonly text: string };
  retryCounts: Map<string, number>;
  cancelRequested: boolean;
  compacting: boolean;
  admitChain: Promise<void>;
  deleteLock?: Promise<void>;
}

function decodeMetadata(metadata: unknown): Metadata | undefined {
  if (metadata === undefined) return undefined;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw agentError("invalid_request", "metadata must be a string record");
  }
  const entries = Object.entries(metadata);
  if (entries.length > 16) {
    throw agentError("invalid_request", "metadata may contain at most 16 keys");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.length < 1 || key.length > 64) {
      throw agentError("invalid_request", "a metadata key must be 1 to 64 characters");
    }
    if (typeof value !== "string" || value.length > 512) {
      throw agentError("invalid_request", "each metadata value must be a string of at most 512 characters");
    }
    out[key] = value;
  }
  return out;
}

function decodeIdempotencyKey(key: unknown): string | undefined {
  if (key === undefined) return undefined;
  if (typeof key !== "string" || key.length < 1 || key.length > 256) {
    throw agentError("invalid_request", "idempotencyKey must be 1 to 256 characters");
  }
  return key;
}

function validateTitle(title: unknown): string {
  if (typeof title !== "string" || title.length < 1 || title.length > 200) {
    throw agentError("invalid_request", "session title must be 1 to 200 characters");
  }
  return title;
}

function validateThinkingLevel(level: unknown): ThinkingLevel {
  if (typeof level !== "string" || !VALID_THINKING_LEVELS.has(level)) {
    throw agentError("invalid_request", `invalid thinkingLevel: ${String(level)}`);
  }
  return level as ThinkingLevel;
}

function expandCommandText(text: string, commands: readonly DshCommand[]): string {
  if (!text.startsWith("/")) return text;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return text;
  const [, name, rest = ""] = match;
  const command = commands.find((candidate) => candidate.name === name);
  return command === undefined ? text : command.expand(rest);
}

function normalizeSendContent(
  content: SendRequest["content"],
  commands: readonly DshCommand[],
): {
  readonly rawParts: readonly ContentPart[];
  readonly expandedParts: readonly ContentPart[];
} {
  if (typeof content === "string") {
    if (content.length === 0) {
      throw agentError("invalid_request", "message content must not be empty");
    }
    const expanded = expandCommandText(content, commands);
    return {
      rawParts: [{ type: "text", text: content }],
      expandedParts: [{ type: "text", text: expanded }],
    };
  }
  if (!Array.isArray(content) || content.length === 0) {
    throw agentError("invalid_request", "message content must contain at least one part");
  }
  const rawParts: ContentPart[] = [];
  const expandedParts: ContentPart[] = [];
  let expandedFirstText = false;
  for (const part of content) {
    if (part.type === "text") {
      rawParts.push({ type: "text", text: part.text });
      if (!expandedFirstText) {
        expandedFirstText = true;
        expandedParts.push({ type: "text", text: expandCommandText(part.text, commands) });
      } else {
        expandedParts.push({ type: "text", text: part.text });
      }
    } else if (part.type === "image" && "data" in part) {
      rawParts.push(part);
      expandedParts.push(part);
    } else {
      throw agentError("invalid_request", "unsupported content part");
    }
  }
  return { rawParts, expandedParts };
}

function toDshBlocks(parts: readonly ContentPart[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image" && "ref" in part) {
      blocks.push({ type: "text", text: `${IMAGE_REF_PREFIX}${part.ref}` });
    }
  }
  return blocks;
}

function createEventChannel(onClose: () => void): {
  readonly watcher: Watcher;
  readonly iterable: AsyncIterable<SequencedEvent>;
} {
  const queue: SequencedEvent[] = [];
  let closed = false;
  let waiting: ((result: IteratorResult<SequencedEvent>) => void) | undefined;

  const watcher: Watcher = {
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
    },
  };

  async function* generate(): AsyncGenerator<SequencedEvent> {
    try {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift() as SequencedEvent;
          continue;
        }
        if (closed) return;
        const next = await new Promise<IteratorResult<SequencedEvent>>((resolve) => {
          waiting = resolve;
        });
        if (next.done) return;
        yield next.value;
      }
    } finally {
      closed = true;
      onClose();
    }
  }

  return {
    watcher,
    iterable: { [Symbol.asyncIterator]: () => generate() },
  };
}

function makeAgentOptions(model: ModelRef | undefined, thinkingLevel: ThinkingLevel | undefined): AgentOptions {
  return {
    ...(model !== undefined ? { provider: model.provider, model: model.modelId } : {}),
    ...(thinkingLevel !== undefined ? { reasoningEffort: thinkingLevel as ReasoningEffortId } : {}),
  };
}

/**
 * Open a FastAgent instance on the experimental DSH harness.
 * Validates `name`, `workdir`, `sandbox` policy, and bridged `tools` fail-fast before booting Cordis.
 * @public
 */
export async function openDshAgent(options: DshHarnessOptions): Promise<DshAgent> {
  if (!options.name || options.name.trim() === "") {
    throw new AgentError({ code: "invalid_request", message: "DSH agent name must be non-empty", retryable: false });
  }
  if (!isAbsolute(options.workdir)) {
    throw new AgentError({
      code: "invalid_request",
      message: `DSH workdir must be an absolute path, got ${JSON.stringify(options.workdir)}`,
      retryable: false,
    });
  }
  const sandboxMode = options.sandbox ?? "workspace";
  if (sandboxMode !== "off" && sandboxMode !== "workspace" && sandboxMode !== "read-only") {
    throw agentError("invalid_request", `invalid sandbox mode: ${String(sandboxMode)}`);
  }
  buildDshSandboxPolicy({
    workdir: options.workdir,
    mode: sandboxMode,
    ...(options.sandboxNetwork === undefined ? {} : { network: options.sandboxNetwork }),
  });
  let enabledCodingTools: readonly ("read" | "write" | "edit" | "bash")[];
  try {
    enabledCodingTools = resolveEnabledCodingTools(options.codingTools);
  } catch (error) {
    throw agentError("invalid_request", error instanceof Error ? error.message : String(error));
  }
  const userTools = options.tools ?? [];
  for (const tool of userTools) toDshToolDefinition(tool);
  const codingToolNames = new Set<string>(enabledCodingTools);
  for (const tool of userTools) {
    if (codingToolNames.has(tool.name)) {
      throw agentError("invalid_request", `duplicate tool name "${tool.name}" conflicts with built-in coding tool`);
    }
  }

  const store: DshEventStoreBackend = options.storage ?? new MemoryDshEventStore();
  const toolsByName = new Map<string, FastAgentToolLike>();
  const commandsOf = () => options.commands?.() ?? [];
  const maxRetries = options.retry?.maxRetries ?? 1;
  const baseDelayMs = options.retry?.baseDelayMs ?? 1;

  const liveSessions = new Map<string, LiveSession>();
  const allMessages = new Map<string, Map<string, DshStoredMessage>>();
  const messagesByKey = new Map<string, Map<string, string>>();
  let nextSessionOrder = 1;
  let closing = false;

  const emitNow = (live: LiveSession, event: SessionEvent) => {
    const seq = ++live.eventSeq;
    for (const watcher of live.watchers) watcher.push({ seq, event });
  };

  const broadcast = (live: LiveSession, event: SessionEvent) => {
    if (live.pendingSettlement !== undefined) {
      live.bufferedEvents.push(event);
      return;
    }
    emitNow(live, event);
  };

  const failSessionWatchersAndWaiters = (sessionId: string | undefined, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const errData: AgentErrorData = { code: "unavailable", message, retryable: true };
    const targets =
      sessionId !== undefined ? [liveSessions.get(sessionId)].filter(Boolean) : [...liveSessions.values()];
    for (const live of targets as LiveSession[]) {
      live.storageErrored = true;
      live.bufferedEvents.length = 0;
      const seq = ++live.eventSeq;
      for (const watcher of [...live.watchers]) {
        watcher.push({ seq, event: { type: "stream_error", error: errData } });
        watcher.end();
      }
      for (const [msgId, waiterSet] of live.waiters) {
        for (const waiter of [...waiterSet]) {
          waiter.reject(agentError("unconfirmed", message, { sessionId: live.meta.id, messageId: msgId }));
        }
        waiterSet.clear();
      }
    }
  };

  const ctx = new Context();
  ctx.plugin(SessionStore);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(createDshPersistencePlugin(store, failSessionWatchersAndWaiters));
  ctx.plugin(LlmRuntime);
  ctx.plugin(ToolsService);
  ctx.plugin(SystemPrompt);
  ctx.plugin(AgentRegistry);
  ctx.plugin(AgentLoop);
  if (sandboxMode !== "off") {
    ctx.plugin(LocalSandboxProvider);
  }

  const requiredServices = [
    "sessions",
    "sessionPersistence",
    "llm",
    "tools",
    "systemPrompt",
    "agents",
    "agentLoop",
    ...(sandboxMode !== "off" ? (["sandbox"] as const) : []),
  ] as const;

  const ready = new Promise<void>((resolve) => {
    ctx.inject(requiredServices as unknown as string[], () => {
      ctx.tools.setExecutor(new NativeToolExecutor(ctx));
      resolve();
    });
  });
  await ready;

  const builtInCodingTools = buildCodingTools(enabledCodingTools, {
    workdir: options.workdir,
    sandbox: sandboxMode,
    getSandboxProvider: () => ctx.get("sandbox"),
    ...(options.protectedPaths !== undefined ? { protectedPaths: options.protectedPaths } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const toolsList: FastAgentToolLike[] = [...builtInCodingTools, ...userTools];
  for (const tool of toolsList) toolsByName.set(tool.name, tool);

  if (options.systemPrompt !== undefined && options.systemPrompt.length > 0) {
    ctx.systemPrompt.section({
      name: "fastagent-system",
      order: 10,
      text: options.systemPrompt,
      interpolate: false,
    });
  }

  if (options.models !== undefined) {
    const providerIds = options.models.getProviders().map((provider) => provider.id);
    if (providerIds.length > 0) {
      const adapter = new PiAiModelsAdapter(options.models, {
        resolveAttachment: async (sessionId, ref) => store.getAttachment?.(sessionId, ref),
        onCallCost: (sessionId, record) => {
          if (sessionId === undefined) return;
          const live = liveSessions.get(sessionId);
          if (live !== undefined) live.pendingCosts.push(record.cost);
        },
      });
      ctx.llm.registerAdapter(providerIds, adapter);
    }
  }

  const toolRuntime = {
    toolsByName,
    onProgress: (progress: { sessionId: string; toolCallId: string; text: string; output?: string }) => {
      const live = liveSessions.get(progress.sessionId);
      if (live === undefined) return;
      const active = live.activeTools.get(progress.toolCallId);
      if (active === undefined) return;
      live.activeTools.set(progress.toolCallId, { ...active, progress: progress.text });
      broadcast(live, {
        type: "tool_progress",
        toolCallId: progress.toolCallId,
        text: progress.text,
        ...(progress.output !== undefined ? { output: progress.output } : {}),
      });
    },
  };

  for (const tool of toolsList) {
    ctx.tools.register(bridgeDshRuntimeTool(tool, toolRuntime));
  }

  const persistSessionMeta = async (meta: DshStoredSession) => {
    if (store.putSessionMeta !== undefined) {
      await store.putSessionMeta(meta);
    }
  };

  const persistMessage = async (stored: DshStoredMessage) => {
    let bySession = allMessages.get(stored.sessionId);
    if (bySession === undefined) {
      bySession = new Map();
      allMessages.set(stored.sessionId, bySession);
    }
    bySession.set(stored.id, stored);
    if (stored.idempotencyKey !== undefined) {
      let keys = messagesByKey.get(stored.sessionId);
      if (keys === undefined) {
        keys = new Map();
        messagesByKey.set(stored.sessionId, keys);
      }
      keys.set(stored.idempotencyKey, stored.id);
    }
    if (store.putMessage !== undefined) {
      await store.putMessage(stored);
    }
  };

  const getStoredMessage = (sessionId: string, messageId: string): DshStoredMessage | undefined =>
    allMessages.get(sessionId)?.get(messageId);

  const notifyMessageSettled = (live: LiveSession, message: Message) => {
    const waiters = live.waiters.get(message.id);
    if (waiters !== undefined) {
      for (const waiter of [...waiters]) waiter.resolve(message);
      waiters.clear();
      live.waiters.delete(message.id);
    }
  };

  const readSessionRawEvents = async (live: LiveSession): Promise<readonly DshSessionEventRecord[]> => {
    if (live.dshAgent !== undefined) {
      return live.dshAgent.session.snapshotEvents();
    }
    const handle = await store.open(live.meta.id, "read");
    try {
      const { events } = await handle.read();
      return events as unknown as readonly DshSessionEventRecord[];
    } finally {
      await handle.close();
    }
  };

  const buildSessionSnapshotFromEvents = (live: LiveSession, rawEvents: readonly DshSessionEventRecord[]): Session => {
    const contextUsage = deriveContextUsage(rawEvents, options.models, live.meta.inheritedContextUsage);
    const isRunning =
      live.dshAgent?.status === "running" || live.activeTurnMessageIds.length > 0 || live.queuedMessages.length > 0;
    const reply = live.liveReply.active
      ? {
          text: live.liveReply.text,
          ...(live.liveReply.thinking.length > 0 ? { thinking: live.liveReply.thinking } : {}),
        }
      : undefined;
    const activeTools = live.activeTools.size > 0 ? [...live.activeTools.values()] : undefined;
    const queuedMessages = live.queuedMessages.length > 0 ? [...live.queuedMessages] : undefined;
    return {
      id: live.meta.id,
      status: isRunning ? "running" : "idle",
      ...(live.meta.title !== undefined ? { title: live.meta.title } : {}),
      createdAt: live.meta.createdAt,
      updatedAt: live.meta.updatedAt,
      ...(live.meta.model !== undefined ? { model: live.meta.model } : {}),
      ...(live.meta.thinkingLevel !== undefined ? { thinkingLevel: live.meta.thinkingLevel } : {}),
      ...(live.meta.instructions !== undefined ? { instructions: live.meta.instructions } : {}),
      ...(live.meta.tools !== undefined ? { tools: [...live.meta.tools] } : {}),
      ...(reply !== undefined ? { reply } : {}),
      ...(activeTools !== undefined ? { activeTools } : {}),
      ...(queuedMessages !== undefined ? { queuedMessages } : {}),
      ...(live.compacting ? { compacting: true } : {}),
      ...(contextUsage !== undefined ? { contextUsage } : {}),
      usage: structuredClone(live.meta.usage),
    };
  };

  const buildSessionSnapshot = async (live: LiveSession): Promise<Session> => {
    const rawEvents = await readSessionRawEvents(live);
    return buildSessionSnapshotFromEvents(live, rawEvents);
  };

  const applyScopedSettings = (live: LiveSession) => {
    const dshAgent = live.dshAgent;
    if (dshAgent === undefined) return;
    live.instructionsDisposer?.();
    live.instructionsDisposer = undefined;
    if (live.meta.instructions !== undefined && live.meta.instructions.length > 0) {
      live.instructionsDisposer = dshAgent.ctx.systemPrompt.section({
        name: "fastagent-session-instructions",
        order: 90,
        text: live.meta.instructions,
        interpolate: false,
      });
    }
    live.toolsDisposer?.();
    live.toolsDisposer = undefined;
    if (live.meta.tools !== undefined) {
      const allowed = live.meta.tools.filter((name) => toolsByName.has(name));
      if (allowed.length > 0) {
        live.toolsDisposer = dshAgent.ctx.tools.restrict({ allow: allowed });
      } else if (toolsByName.size > 0) {
        live.toolsDisposer = dshAgent.ctx.tools.restrict({ deny: [...toolsByName.keys()] });
      }
    }
    const effectiveModel = live.meta.model ?? options.model;
    const effectiveThinking = live.meta.thinkingLevel ?? options.thinkingLevel;
    if (effectiveModel !== undefined) {
      dshAgent.model.select({
        provider: effectiveModel.provider,
        model: effectiveModel.modelId,
        ...(effectiveThinking !== undefined && effectiveThinking !== "off"
          ? { reasoningEffort: effectiveThinking as ReasoningEffortId }
          : {}),
      });
    }
  };

  const bindDshAgentEvents = (live: LiveSession, dshAgent: DshLoopAgent) => {
    const agentCtx = dshAgent.ctx;

    for (const event of dshAgent.session.snapshotEvents()) {
      if (event.type === "assistant/message") {
        for (const block of event.data.message.content) {
          if (block.type === "tool-call") live.toolNamesByCallId.set(block.id, block.name);
        }
      }
    }

    agentCtx.on("agent/request-error", async (payload, next) => {
      const retryable =
        payload.failure.code === "SERVER" ||
        payload.failure.code === "RATE_LIMIT" ||
        payload.failure.status === 503 ||
        payload.failure.status === 429;
      if (!retryable || maxRetries <= 0) return next();
      const key = `${payload.turn}:${payload.step}`;
      const prev = live.retryCounts.get(key) ?? 0;
      if (prev >= maxRetries) return next();
      const attempt = prev + 1;
      live.retryCounts.set(key, attempt);
      const delayMs = baseDelayMs * attempt;
      broadcast(live, {
        type: "retrying",
        attempt,
        maxAttempts: maxRetries,
        delayMs,
        reason: payload.failure.message,
      });
      await new Promise<void>((resolve) => {
        if (payload.signal.aborted) return resolve();
        const timer = setTimeout(resolve, delayMs);
        payload.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (payload.signal.aborted) return next();
      return { kind: "retry" as const };
    });

    agentCtx.on("agent/status", ({ status }: { status: "idle" | "running" }) => {
      if (status !== "idle" || closing || live.storageErrored || live.meta.deleted) return;
      if (dshAgent.inbox.nextTurn.length > 0 && live.activeTurnMessageIds.length === 0) {
        const pending = [...dshAgent.inbox.nextTurn];
        dshAgent.inbox.clear();
        for (const item of pending) dshAgent.followup(item);
      }
    });

    agentCtx.on("agent/assistant-stream", ({ frame }: { frame: AssistantStreamFrame }) => {
      if (frame.type === "start") {
        live.liveReply = { active: true, text: "", thinking: "" };
        return;
      }
      if (frame.type === "chunk") {
        if (frame.chunk.type === "text-delta") {
          live.liveReply.active = true;
          live.liveReply.text += frame.chunk.text;
          broadcast(live, { type: "delta", channel: "text", text: frame.chunk.text });
        } else if (frame.chunk.type === "reasoning-delta") {
          live.liveReply.active = true;
          live.liveReply.thinking += frame.chunk.text;
          broadcast(live, { type: "delta", channel: "thinking", text: frame.chunk.text });
        }
        return;
      }
      if (frame.type === "end") {
        live.liveReply = { active: false, text: "", thinking: "" };
      }
    });

    agentCtx.on("session/event", (_session, event) => {
      if (event.type === "turn/start") {
        live.lastAnswerInTurn = undefined;
        live.cancelRequested = false;
        return;
      }

      if (event.type === "tool/call") {
        const callId = String(event.data.callId);
        live.toolNamesByCallId.set(callId, event.data.name);
        let parsedArgs: unknown = {};
        try {
          parsedArgs = JSON.parse(event.data.arguments || "{}");
        } catch {
          parsedArgs = {};
        }
        live.activeTools.set(callId, {
          toolCallId: callId,
          name: event.data.name,
          status: "running",
        });
        broadcast(live, {
          type: "tool_started",
          toolCallId: callId,
          name: event.data.name,
          args: parsedArgs as SessionEvent extends { type: "tool_started"; args: infer A } ? A : never,
        });
        return;
      }

      if (event.type === "assistant/message") {
        const cost = live.pendingCosts.shift();
        if (cost !== undefined) live.costBySeq.set(event.seq, cost);
        live.liveReply = { active: false, text: "", thinking: "" };
      }

      if (event.type === "tool/result") {
        const callId = String(event.data.message.toolCallId);
        live.activeTools.delete(callId);
      }

      const projected = projectSessionEvent(event, live.toolNamesByCallId, live.costBySeq);
      if (projected !== undefined) {
        if (event.type === "user/message" && projected.messageId !== undefined) {
          const msgId = projected.messageId;
          live.queuedMessages = live.queuedMessages.filter((q) => q.id !== msgId);
          if (!live.activeTurnMessageIds.includes(msgId)) {
            live.activeTurnMessageIds.push(msgId);
          }
          const existing = getStoredMessage(live.meta.id, msgId);
          if (existing !== undefined && !hasEnded(existing)) {
            const updated: DshStoredMessage = {
              ...existing,
              status: "running",
              entryId: projected.entry.id,
              updatedAt: Date.now(),
            };
            void persistMessage(updated).catch((error) => failSessionWatchersAndWaiters(live.meta.id, error));
          }
        }

        if (event.type === "assistant/message") {
          if (projected.modelKey !== undefined && projected.tokens !== undefined) {
            addTokens(live.meta.usage.models, projected.modelKey, projected.tokens);
            live.meta = { ...live.meta, updatedAt: Date.now() };
            void persistSessionMeta(live.meta).catch((error) => failSessionWatchersAndWaiters(live.meta.id, error));
          }
          if (!projected.hasToolCalls) {
            live.lastAnswerInTurn = { entryId: projected.entry.id, text: projected.assistantText ?? "" };
          } else {
            live.lastAnswerInTurn = undefined;
          }
        }

        broadcast(live, { type: "entry", entry: projected.entry });
        return;
      }

      if (event.type === "user/message" && event.data.source.kind === "fastagent-recovery") {
        const msgId = event.data.source.messageId;
        if (!live.activeTurnMessageIds.includes(msgId)) {
          live.activeTurnMessageIds.push(msgId);
        }
        return;
      }

      if (event.type === "turn/end") {
        const reason = event.data.reason;
        const turnMessageIds = live.activeTurnMessageIds.splice(0);
        const answer = live.lastAnswerInTurn;
        live.lastAnswerInTurn = undefined;
        live.activeTools.clear();
        live.liveReply = { active: false, text: "", thinking: "" };
        live.cancelRequested = false;

        if (reason.kind === "aborted" && reason.reason.kind === "disposed") {
          return;
        }
        if (reason.kind === "interrupted") {
          return;
        }

        const settled: DshStoredMessage[] = [];
        for (const msgId of turnMessageIds) {
          const stored = getStoredMessage(live.meta.id, msgId);
          if (stored === undefined || hasEnded(stored)) continue;
          let next: DshStoredMessage;
          if (reason.kind === "completed") {
            next = {
              ...stored,
              status: "completed",
              ...(answer !== undefined ? { answer } : {}),
              updatedAt: Date.now(),
            };
          } else if (reason.kind === "max-tokens") {
            next = {
              ...stored,
              status: "incomplete",
              ...(answer !== undefined ? { answer } : {}),
              updatedAt: Date.now(),
            };
          } else if (reason.kind === "aborted") {
            next = {
              ...stored,
              status: "canceled",
              updatedAt: Date.now(),
            };
          } else if (reason.kind === "error") {
            next = {
              ...stored,
              status: "failed",
              error: classifyLlmFailure(reason.error),
              updatedAt: Date.now(),
            };
          } else {
            next = {
              ...stored,
              status: "failed",
              error: { code: "model_error", message: `turn ended with ${reason.kind}`, retryable: false },
              updatedAt: Date.now(),
            };
          }
          settled.push(next);
        }

        const prevSettlement = live.pendingSettlement ?? Promise.resolve();
        const settleTask = prevSettlement
          .catch(() => {})
          .then(async () => {
            await ctx.sessions.flush(dshAgent.session);
            for (const next of settled) {
              if (store.putMessage !== undefined) await store.putMessage(next);
            }
            live.meta = { ...live.meta, updatedAt: Date.now() };
            await persistSessionMeta(live.meta);
            live.storageErrored = false;
            for (const next of settled) {
              let bySession = allMessages.get(next.sessionId);
              if (bySession === undefined) {
                bySession = new Map();
                allMessages.set(next.sessionId, bySession);
              }
              bySession.set(next.id, next);
              const pub = toPublicMessage(next);
              emitNow(live, { type: "done", message: pub });
              notifyMessageSettled(live, pub);
            }
          })
          .catch((error) => {
            failSessionWatchersAndWaiters(live.meta.id, error);
          })
          .finally(() => {
            if (live.pendingSettlement === settleTask) {
              live.pendingSettlement = undefined;
              const buffered = live.bufferedEvents.splice(0);
              if (!live.storageErrored) {
                for (const event of buffered) emitNow(live, event);
              }
            }
          });
        live.pendingSettlement = settleTask;
      }
    });
  };

  const ensureDshAgent = async (live: LiveSession): Promise<DshLoopAgent> => {
    if (live.dshAgent !== undefined) return live.dshAgent;
    const effectiveModel = live.meta.model ?? options.model;
    const effectiveThinking = live.meta.thinkingLevel ?? options.thinkingLevel;
    const handle = await ctx.agents.resume({
      resumeSessionId: SessionId(live.meta.id),
      agentOptions: makeAgentOptions(effectiveModel, effectiveThinking),
    });
    live.dshHandle = handle;
    live.dshAgent = handle.agent;
    bindDshAgentEvents(live, handle.agent);
    applyScopedSettings(live);
    return handle.agent;
  };

  const requireSession = (sessionId: string): LiveSession => {
    const live = liveSessions.get(sessionId);
    if (live === undefined || live.meta.deleted) {
      throw agentError("not_found", `session "${sessionId}" not found`);
    }
    return live;
  };

  const pushStateSnapshot = async (live: LiveSession) => {
    if (live.watchers.size === 0) return;
    const session = await buildSessionSnapshot(live);
    broadcast(live, { type: "state", session });
  };

  const storedMetas = (await store.listSessionMetas?.()) ?? [];
  for (const meta of storedMetas) {
    if (meta.order >= nextSessionOrder) nextSessionOrder = meta.order + 1;
    if (meta.deleted) continue;
    liveSessions.set(meta.id, {
      meta: structuredClone(meta),
      watchers: new Set(),
      waiters: new Map(),
      eventSeq: 0,
      bufferedEvents: [],
      storageErrored: false,
      toolNamesByCallId: new Map(),
      costBySeq: new Map(),
      pendingCosts: [],
      liveReply: { active: false, text: "", thinking: "" },
      activeTools: new Map(),
      activeTurnMessageIds: [],
      queuedMessages: [],
      retryCounts: new Map(),
      cancelRequested: false,
      compacting: false,
      admitChain: Promise.resolve(),
    });
  }

  const storedMessages = (await store.listMessages?.()) ?? [];
  for (const msg of storedMessages) {
    let bySession = allMessages.get(msg.sessionId);
    if (bySession === undefined) {
      bySession = new Map();
      allMessages.set(msg.sessionId, bySession);
    }
    bySession.set(msg.id, structuredClone(msg));
    if (msg.idempotencyKey !== undefined) {
      let keys = messagesByKey.get(msg.sessionId);
      if (keys === undefined) {
        keys = new Map();
        messagesByKey.set(msg.sessionId, keys);
      }
      keys.set(msg.idempotencyKey, msg.id);
    }
  }

  // Crash/restart recovery: resume every session with unsettled running or queued messages,
  // or refuse cleanly when opened by a one-shot command (`unfinished: "refuse"`).
  for (const live of liveSessions.values()) {
    const sessionMsgs = [...(allMessages.get(live.meta.id)?.values() ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    const runningMsgs = sessionMsgs.filter((m) => m.status === "running");
    const queuedMsgs = sessionMsgs.filter((m) => m.status === "queued");
    if (runningMsgs.length === 0 && queuedMsgs.length === 0) continue;
    if (options.unfinished === "refuse") {
      await ctx.fiber.dispose().catch(() => {});
      throw new Error(
        `this instance has ${runningMsgs.length + queuedMsgs.length} unfinished message(s) from a stopped serve; start the serve (\`fastagent dev\` or \`fastagent start\`) to finish them`,
      );
    }

    const dshAgent = await ensureDshAgent(live);
    for (const q of queuedMsgs) {
      live.queuedMessages.push({ id: q.id, mode: q.whenBusy === "steer" ? "steer" : "queue" });
    }

    const pendingInDsh = new Set<string>();
    for (const item of [...dshAgent.inbox.nextStep, ...dshAgent.inbox.nextTurn]) {
      if (item.source.kind === "fastagent-user") pendingInDsh.add(item.source.messageId);
    }

    if (runningMsgs.length > 0) {
      const target = runningMsgs[0] as DshStoredMessage;
      live.activeTurnMessageIds.push(...runningMsgs.map((m) => m.id));
      // Clear any inbox items that survived SIGKILL so the recovery turn runs strictly
      // BEFORE queued follow-up turns (DSH claims `next-turn` before `next-step` at turn start).
      if (dshAgent.inbox.nextStep.length > 0 || dshAgent.inbox.nextTurn.length > 0) {
        dshAgent.inbox.clear();
      }
      const loggedMessageIds = new Set<string>();
      for (const ev of dshAgent.session.snapshotEvents()) {
        if (ev.type === "user/message" && ev.data.source.kind === "fastagent-user") {
          loggedMessageIds.add(ev.data.source.messageId);
        }
      }
      const unloggedRunning = runningMsgs.filter((m) => !loggedMessageIds.has(m.id));
      if (unloggedRunning.length === 0) {
        const recoveryMsg = createUserMessage({
          content: [{ type: "text", text: "" }],
          source: { kind: "fastagent-recovery", messageId: target.id },
        });
        dshAgent.followup(recoveryMsg);
      } else {
        for (const msg of unloggedRunning) {
          const dshUser = createUserMessage({
            content: toDshBlocks(msg.modelContent),
            source: {
              kind: "fastagent-user",
              messageId: msg.id,
              displayContent: msg.displayContent,
            },
          });
          dshAgent.followup(dshUser);
        }
      }
      for (const q of queuedMsgs) {
        const dshUser = createUserMessage({
          content: toDshBlocks(q.modelContent),
          source: {
            kind: "fastagent-user",
            messageId: q.id,
            displayContent: q.displayContent,
          },
        });
        dshAgent.followup(dshUser);
      }
    } else if (queuedMsgs.length > 0) {
      if (dshAgent.inbox.nextTurn.length > 0) {
        const existing = [...dshAgent.inbox.nextTurn];
        dshAgent.inbox.clear();
        for (const item of existing) dshAgent.followup(item);
      }
      const missingQueued = queuedMsgs.filter((q) => !pendingInDsh.has(q.id));
      for (const q of missingQueued) {
        const dshUser = createUserMessage({
          content: toDshBlocks(q.modelContent),
          source: {
            kind: "fastagent-user",
            messageId: q.id,
            displayContent: q.displayContent,
          },
        });
        dshAgent.followup(dshUser);
      }
    }
  }

  const waitForMessage = async (
    live: LiveSession,
    messageId: string,
    waitSeconds: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Message> => {
    const current = getStoredMessage(live.meta.id, messageId);
    if (current === undefined) throw agentError("not_found", `message "${messageId}" not found`);
    if (hasEnded(current) || waitSeconds === undefined || waitSeconds <= 0) {
      return toPublicMessage(current);
    }
    if (signal?.aborted) throw signal.reason;

    return new Promise<Message>((resolve, reject) => {
      let waiterSet = live.waiters.get(messageId);
      if (waiterSet === undefined) {
        waiterSet = new Set();
        live.waiters.set(messageId, waiterSet);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiterSet?.delete(waiter);
      };
      const waiter: Waiter = {
        resolve: (msg) => {
          cleanup();
          resolve(msg);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason);
      };
      if (Number.isFinite(waitSeconds)) {
        timer = setTimeout(() => {
          cleanup();
          const latest = getStoredMessage(live.meta.id, messageId);
          resolve(toPublicMessage(latest ?? current));
        }, waitSeconds * 1000);
      }
      waiterSet.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const validateWait = (wait: number | undefined): void => {
    if (wait !== undefined && (typeof wait !== "number" || Number.isNaN(wait) || wait < 0)) {
      throw agentError("invalid_request", `wait must be a non-negative number, got ${String(wait)}`);
    }
  };

  const admitMessage = async (request: SendRequest): Promise<{ message: Message; replayed: boolean }> => {
    if (typeof request.sessionId !== "string" || request.sessionId.length === 0) {
      throw agentError("invalid_request", "sessionId must be a non-empty string");
    }
    const live = requireSession(request.sessionId);

    const idempotencyKey = decodeIdempotencyKey(request.idempotencyKey);
    const metadata = decodeMetadata(request.metadata);
    const whenBusy = request.whenBusy ?? "queue";
    if (whenBusy !== "queue" && whenBusy !== "steer" && whenBusy !== "reject") {
      throw agentError("invalid_request", `invalid whenBusy: ${String(whenBusy)}`);
    }
    const commands = commandsOf();
    const { rawParts, expandedParts } = normalizeSendContent(request.content, commands);

    let releaseAdmit!: () => void;
    const prevChain = live.admitChain;
    live.admitChain = new Promise<void>((resolve) => {
      releaseAdmit = resolve;
    });
    await prevChain;

    try {
      if (live.meta.deleted) throw agentError("not_found", `session "${request.sessionId}" not found`);

      if (idempotencyKey !== undefined) {
        const existingId = messagesByKey.get(live.meta.id)?.get(idempotencyKey);
        if (existingId !== undefined) {
          const existing = getStoredMessage(live.meta.id, existingId);
          if (existing !== undefined) {
            return { message: toPublicMessage(existing), replayed: true };
          }
        }
      }

      const effectiveModel = live.meta.model ?? options.model;
      if (effectiveModel === undefined) {
        throw agentError("missing_model", "no model configured for session or agent");
      }
      if (
        options.models !== undefined &&
        options.models.getModel(effectiveModel.provider, effectiveModel.modelId) === undefined
      ) {
        throw agentError(
          "missing_model",
          `model "${effectiveModel.provider}/${effectiveModel.modelId}" is not available`,
          { model: `${effectiveModel.provider}/${effectiveModel.modelId}` },
        );
      }

      if (live.meta.tools !== undefined) {
        const missing = live.meta.tools.filter((name) => !toolsByName.has(name));
        if (missing.length > 0) {
          throw agentError("missing_tool", `session references unavailable tools: ${missing.join(", ")}`, {
            tools: missing,
          });
        }
      }

      live.storageErrored = false;
      const dshAgent = await ensureDshAgent(live);
      const busy = dshAgent.status === "running" || live.activeTurnMessageIds.length > 0;
      if (busy && whenBusy === "reject") {
        throw agentError("busy", "session is currently running another message", { reason: "running" });
      }

      if (live.meta.model === undefined) {
        live.meta = { ...live.meta, model: effectiveModel, updatedAt: Date.now() };
        await persistSessionMeta(live.meta);
        applyScopedSettings(live);
      }

      const displayContent: ContentPart[] = [];
      const modelContent: ContentPart[] = [];
      for (let i = 0; i < rawParts.length; i++) {
        const raw = rawParts[i] as ContentPart;
        const expanded = expandedParts[i] as ContentPart;
        if (raw.type === "image" && "data" in raw) {
          const ref = randomUUID();
          const bytes = Buffer.from(raw.data, "base64");
          await store.putAttachment?.({
            ref,
            sessionId: live.meta.id,
            mimeType: raw.mimeType,
            data: new Uint8Array(bytes),
          });
          const refPart: ContentPart = { type: "image", mimeType: raw.mimeType, ref };
          displayContent.push(refPart);
          modelContent.push(refPart);
        } else {
          displayContent.push(raw);
          modelContent.push(expanded);
        }
      }

      const messageId = randomUUID();
      const now = Date.now();
      const initialStatus: DshStoredMessage["status"] = busy ? "queued" : "running";
      const stored: DshStoredMessage = {
        id: messageId,
        sessionId: live.meta.id,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        status: initialStatus,
        whenBusy,
        displayContent,
        modelContent,
        createdAt: now,
        updatedAt: now,
      };
      await persistMessage(stored);

      if (busy) {
        live.queuedMessages.push({ id: messageId, mode: whenBusy === "steer" ? "steer" : "queue" });
      } else {
        live.activeTurnMessageIds.push(messageId);
      }

      const dshUser = createUserMessage({
        content: toDshBlocks(modelContent),
        source: {
          kind: "fastagent-user",
          messageId,
          displayContent,
        },
      });

      if (busy && whenBusy === "steer") {
        dshAgent.steer(dshUser);
      } else {
        dshAgent.followup(dshUser);
      }

      return { message: toPublicMessage(stored), replayed: false };
    } finally {
      releaseAdmit();
    }
  };

  const getSessionEntries = async (live: LiveSession): Promise<Entry[]> => {
    const rawEvents = await readSessionRawEvents(live);
    return projectSessionLog(rawEvents, live.costBySeq).map((item) => item.entry);
  };

  const agent: DshAgent = {
    async info(): Promise<AgentInfo> {
      const availableModels = options.models !== undefined ? await options.models.getAvailable() : [];
      const modelsList = availableModels.map((model) => ({
        provider: model.provider,
        modelId: model.id,
        ...(model.name ? { name: model.name } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        thinkingLevels: model.reasoning ? [...DEFAULT_THINKING_LEVELS] : (["off"] as ThinkingLevel[]),
      }));
      return {
        name: options.name,
        agent: {
          name: options.agent?.name ?? options.name,
          ...(options.agent?.description !== undefined ? { description: options.agent.description } : {}),
        },
        ...(options.starters !== undefined ? { starters: [...options.starters] } : {}),
        commands: commandsOf().map((cmd) => ({
          name: cmd.name,
          ...(cmd.description !== undefined ? { description: cmd.description } : {}),
        })),
        tools: toolsList.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
        })),
        models: modelsList,
        ...(options.model !== undefined ? { defaultModel: options.model } : {}),
      };
    },

    async usage(): Promise<Usage> {
      return mergeUsages([...liveSessions.values()].map((live) => live.meta.usage));
    },

    sessions: {
      async create(createOptions: CreateSessionOptions = {}): Promise<Session> {
        const title = createOptions.title !== undefined ? validateTitle(createOptions.title) : undefined;
        const thinkingLevel =
          createOptions.thinkingLevel !== undefined ? validateThinkingLevel(createOptions.thinkingLevel) : undefined;
        if (createOptions.tools !== undefined) {
          const invalid = createOptions.tools.filter((name) => !toolsByName.has(name));
          if (invalid.length > 0) {
            throw agentError("invalid_request", `unknown tools: ${invalid.join(", ")}`, { tools: invalid });
          }
        }

        const sessionId = randomUUID();
        const now = Date.now();
        let seed: readonly DshSessionEventRecord[] | undefined;
        let inheritedEventCount: SessionLogOffset | undefined;
        let inheritedEntryCount = 0;
        let inheritedContextUsage: { readonly tokens: number; readonly contextWindow?: number } | undefined;
        let parentSession: ReturnType<typeof SessionId> | undefined;

        if (createOptions.forkFrom !== undefined) {
          const sourceLive = requireSession(createOptions.forkFrom.sessionId);
          const sourceEvents = await readSessionRawEvents(sourceLive);
          let cutSeq: number;
          if (createOptions.forkFrom.entryId !== undefined) {
            const targetSeq = seqForEntryId(createOptions.forkFrom.entryId);
            if (targetSeq === undefined || targetSeq >= sourceEvents.length) {
              throw agentError("not_found", `entry "${createOptions.forkFrom.entryId}" not found`);
            }
            cutSeq = targetSeq;
          } else {
            cutSeq = sourceEvents.length - 1;
          }
          if (cutSeq >= 0) {
            seed = buildForkSeed(sourceEvents, SessionSeq(cutSeq));
            inheritedEventCount = SessionLogOffset(cutSeq + 1);
            inheritedEntryCount = projectSessionLog(sourceEvents.slice(0, cutSeq + 1)).length;
            inheritedContextUsage = deriveContextUsage(
              sourceEvents.slice(0, cutSeq + 1),
              options.models,
              sourceLive.meta.inheritedContextUsage,
            );
            parentSession = SessionId(sourceLive.meta.id);
          }
        }

        const meta: DshStoredSession = {
          id: sessionId,
          createdAt: now,
          updatedAt: now,
          order: nextSessionOrder++,
          deleted: false,
          ...(title !== undefined ? { title } : {}),
          ...(createOptions.model !== undefined ? { model: createOptions.model } : {}),
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
          ...(createOptions.instructions !== undefined ? { instructions: createOptions.instructions } : {}),
          ...(createOptions.tools !== undefined ? { tools: [...createOptions.tools] } : {}),
          inheritedEntryCount,
          ...(inheritedContextUsage !== undefined ? { inheritedContextUsage } : {}),
          usage: emptyUsage(),
        };

        const effectiveModel = meta.model ?? options.model;
        const effectiveThinking = meta.thinkingLevel ?? options.thinkingLevel;
        const handle = await ctx.agents.create({
          sessionId: SessionId(sessionId),
          meta: {
            cwd: options.workdir,
            ...(parentSession !== undefined ? { parentSession, isSeeded: true } : {}),
          },
          ...(seed !== undefined ? { seed } : {}),
          ...(inheritedEventCount !== undefined ? { inheritedEventCount } : {}),
          agentOptions: makeAgentOptions(effectiveModel, effectiveThinking),
        });
        await ctx.sessions.flush(handle.agent.session);

        const live: LiveSession = {
          meta,
          dshAgent: handle.agent,
          dshHandle: handle,
          watchers: new Set(),
          waiters: new Map(),
          eventSeq: 0,
          bufferedEvents: [],
          storageErrored: false,
          toolNamesByCallId: new Map(),
          costBySeq: new Map(),
          pendingCosts: [],
          liveReply: { active: false, text: "", thinking: "" },
          activeTools: new Map(),
          activeTurnMessageIds: [],
          queuedMessages: [],
          retryCounts: new Map(),
          cancelRequested: false,
          compacting: false,
          admitChain: Promise.resolve(),
        };
        liveSessions.set(sessionId, live);
        bindDshAgentEvents(live, handle.agent);
        applyScopedSettings(live);
        await persistSessionMeta(meta);
        return buildSessionSnapshot(live);
      },

      async get(sessionId: string): Promise<Session> {
        const live = requireSession(sessionId);
        return buildSessionSnapshot(live);
      },

      async list(listOptions: ListOptions = {}): Promise<Page<Session>> {
        const limit = listOptions.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          throw agentError("invalid_request", `limit must be between 1 and 500, got ${String(limit)}`);
        }
        const ordered = [...liveSessions.values()]
          .filter((live) => !live.meta.deleted)
          .sort((a, b) => b.meta.order - a.meta.order);
        let start = 0;
        if (listOptions.after !== undefined) {
          const idx = ordered.findIndex((live) => live.meta.id === listOptions.after);
          if (idx === -1) throw agentError("not_found", `unknown session cursor "${listOptions.after}"`);
          start = idx + 1;
        }
        const slice = ordered.slice(start, start + limit);
        const data = await Promise.all(slice.map((live) => buildSessionSnapshot(live)));
        const hasNext = start + slice.length < ordered.length;
        return {
          data,
          ...(hasNext && data.at(-1) !== undefined ? { next: data.at(-1)?.id } : {}),
        };
      },

      async update(sessionId: string, changes: SessionChanges): Promise<Session> {
        const live = requireSession(sessionId);
        const keys = Object.keys(changes).filter((k) => changes[k as keyof SessionChanges] !== undefined);
        if (keys.length === 0) {
          throw agentError("invalid_request", "update requires at least one field");
        }
        let nextMeta = { ...live.meta };
        if (changes.title !== undefined) {
          if (changes.title === null) {
            const { title: _dropped, ...rest } = nextMeta;
            nextMeta = rest;
          } else {
            nextMeta = { ...nextMeta, title: validateTitle(changes.title) };
          }
        }
        if (changes.model !== undefined) {
          if (changes.model === null) {
            const { model: _dropped, ...rest } = nextMeta;
            nextMeta = rest;
          } else {
            nextMeta = { ...nextMeta, model: changes.model };
          }
        }
        if (changes.thinkingLevel !== undefined) {
          if (changes.thinkingLevel === null) {
            const { thinkingLevel: _dropped, ...rest } = nextMeta;
            nextMeta = rest;
          } else {
            nextMeta = { ...nextMeta, thinkingLevel: validateThinkingLevel(changes.thinkingLevel) };
          }
        }
        if (changes.instructions !== undefined) {
          if (changes.instructions === null) {
            const { instructions: _dropped, ...rest } = nextMeta;
            nextMeta = rest;
          } else {
            nextMeta = { ...nextMeta, instructions: changes.instructions };
          }
        }
        if (changes.tools !== undefined) {
          if (changes.tools === null) {
            const { tools: _dropped, ...rest } = nextMeta;
            nextMeta = rest;
          } else {
            const invalid = changes.tools.filter((name) => !toolsByName.has(name));
            if (invalid.length > 0) {
              throw agentError("invalid_request", `unknown tools: ${invalid.join(", ")}`, { tools: invalid });
            }
            nextMeta = { ...nextMeta, tools: [...changes.tools] };
          }
        }

        nextMeta = { ...nextMeta, updatedAt: Date.now() };
        live.meta = nextMeta;
        applyScopedSettings(live);
        await persistSessionMeta(nextMeta);
        const snapshot = await buildSessionSnapshot(live);
        broadcast(live, { type: "state", session: snapshot });
        return snapshot;
      },

      async delete(sessionId: string): Promise<void> {
        const live = liveSessions.get(sessionId);
        if (live === undefined || live.meta.deleted || live.deleteLock !== undefined) {
          throw agentError("not_found", `session "${sessionId}" not found`);
        }
        live.meta = { ...live.meta, deleted: true, updatedAt: Date.now() };
        live.deleteLock = (async () => {
          live.dshAgent?.cancel({ kind: "user" });
          const deletedError: AgentErrorData = {
            code: "not_found",
            message: `session "${sessionId}" deleted`,
            retryable: false,
          };
          const seq = ++live.eventSeq;
          for (const watcher of [...live.watchers]) {
            watcher.push({ seq, event: { type: "stream_error", error: deletedError } });
            watcher.end();
          }
          live.watchers.clear();
          const deleteRejection = agentError("not_found", `session "${sessionId}" deleted`);
          for (const waiterSet of live.waiters.values()) {
            for (const waiter of [...waiterSet]) waiter.reject(deleteRejection);
            waiterSet.clear();
          }
          live.waiters.clear();
          live.instructionsDisposer?.();
          live.toolsDisposer?.();
          await persistSessionMeta(live.meta);
          liveSessions.delete(sessionId);
          await live.dshHandle?.dispose().catch(() => {});
        })();
        await live.deleteLock;
      },

      async entries(sessionId: string, entriesOptions?: EntriesOptions): Promise<Page<Entry>> {
        const live = requireSession(sessionId);
        const all = await getSessionEntries(live);
        return paginateEntries(all, entriesOptions);
      },

      async attachment(sessionId: string, ref: string): Promise<{ mimeType: string; data: Uint8Array }> {
        requireSession(sessionId);
        const found = await store.getAttachment?.(sessionId, ref);
        if (found === undefined || found.sessionId !== sessionId) {
          throw agentError("not_found", `attachment "${ref}" not found`);
        }
        return { mimeType: found.mimeType, data: found.data };
      },

      async cancel(sessionId: string): Promise<{ stopped: string[] }> {
        const live = requireSession(sessionId);
        const runningIds = [...live.activeTurnMessageIds];
        const queuedIds = live.queuedMessages.map((q) => q.id);
        if (runningIds.length === 0 && queuedIds.length === 0) {
          return { stopped: [] };
        }
        live.cancelRequested = true;
        live.queuedMessages = [];
        live.dshAgent?.cancel({ kind: "user" });

        for (const msgId of queuedIds) {
          const existing = getStoredMessage(live.meta.id, msgId);
          if (existing !== undefined && !hasEnded(existing)) {
            const canceled: DshStoredMessage = {
              ...existing,
              status: "canceled",
              updatedAt: Date.now(),
            };
            await persistMessage(canceled);
            const pub = toPublicMessage(canceled);
            broadcast(live, { type: "done", message: pub });
            notifyMessageSettled(live, pub);
          }
        }

        return { stopped: [...runningIds, ...queuedIds] };
      },

      async compact(sessionId: string, compactOptions?: { instructions?: string }): Promise<void> {
        const live = requireSession(sessionId);
        const dshAgent = await ensureDshAgent(live);
        live.compacting = true;
        broadcast(live, { type: "compaction_started", trigger: "manual" });
        await pushStateSnapshot(live);

        try {
          await dshAgent.runMaintenance(async () => {
            const replaceableSeqs = dshAgent.session.surface.nodes.filter((seq) => {
              const ev = dshAgent.session.eventAt(seq);
              return ev !== undefined && ev.type !== "system/message";
            });
            const summaryParts = [
              compactOptions?.instructions ? `Instructions: ${compactOptions.instructions}` : undefined,
              `Compacted ${replaceableSeqs.length} prior conversation messages.`,
            ].filter(Boolean);
            const summary = summaryParts.join(" ");
            const compactionMsg = createUserMessage({
              content: [{ type: "text", text: summary }],
              source: { kind: "fastagent-compaction", summary },
            });
            if (replaceableSeqs.length > 0) {
              const first = replaceableSeqs[0];
              const last = replaceableSeqs.at(-1);
              if (first !== undefined && last !== undefined) {
                dshAgent.session.append("user/message", compactionMsg, {
                  surfaceOp: { op: "replace", startSeq: first, endSeq: last },
                  sourceEventSeqs: [...replaceableSeqs],
                });
              }
            } else {
              dshAgent.session.append("user/message", compactionMsg, { surfaceOp: "append" });
            }
            await ctx.sessions.flush(dshAgent.session);
          });
          const { inheritedContextUsage: _cleared, ...restMeta } = live.meta;
          live.meta = { ...restMeta, updatedAt: Date.now() };
          await persistSessionMeta(live.meta);
        } catch (error) {
          broadcast(live, {
            type: "compaction_failed",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          live.compacting = false;
          await pushStateSnapshot(live);
        }
      },

      events(sessionId: string, eventOptions?: { after?: string; signal?: AbortSignal }): AsyncIterable<SessionEvent> {
        let cleanup = () => {};
        async function* stream(): AsyncGenerator<SessionEvent> {
          const live = requireSession(sessionId);
          const { watcher, iterable } = createEventChannel(() => {
            live.watchers.delete(watcher);
          });
          live.watchers.add(watcher);
          cleanup = () => {
            live.watchers.delete(watcher);
            watcher.end();
          };

          if (live.pendingSettlement !== undefined) {
            await live.pendingSettlement.catch(() => {});
          }
          let rawEvents: readonly DshSessionEventRecord[];
          if (live.dshAgent !== undefined) {
            rawEvents = live.dshAgent.session.snapshotEvents();
          } else {
            rawEvents = await readSessionRawEvents(live);
            const resumed = live.dshAgent as DshLoopAgent | undefined;
            if (resumed !== undefined) {
              rawEvents = resumed.session.snapshotEvents();
            }
          }
          const watermark = live.eventSeq;
          const all = projectSessionLog(rawEvents, live.costBySeq).map((item) => item.entry);
          let replay: Entry[] = [];
          if (eventOptions?.after === "start") {
            replay = all;
          } else if (eventOptions?.after !== undefined) {
            const idx = all.findIndex((entry) => entry.id === eventOptions.after);
            if (idx === -1) {
              throw agentError("not_found", `unknown entry cursor "${eventOptions.after}"`);
            }
            replay = all.slice(idx + 1);
          }
          const replayedIds = new Set(replay.map((entry) => entry.id));
          const snapshot = buildSessionSnapshotFromEvents(live, rawEvents);

          for (const entry of replay) {
            yield { type: "entry", entry };
          }
          yield { type: "state", session: snapshot };

          for await (const item of iterable) {
            if (item.seq <= watermark) continue;
            if (item.event.type === "entry" && replayedIds.has(item.event.entry.id)) continue;
            yield item.event;
          }
        }

        return {
          [Symbol.asyncIterator]: () => leavableIterator(stream(), () => cleanup(), eventOptions?.signal),
        };
      },
    },

    messages: {
      async send(request: SendRequest, sendOptions?: { wait?: number; signal?: AbortSignal }): Promise<Message> {
        validateWait(sendOptions?.wait);
        if (sendOptions?.signal?.aborted) throw sendOptions.signal.reason;
        const { message } = await admitMessage(request);
        const live = liveSessions.get(message.sessionId);
        if (live === undefined) return message;
        return waitForMessage(live, message.id, sendOptions?.wait, sendOptions?.signal);
      },

      stream(request: SendRequest, streamOptions?: { signal?: AbortSignal }): AsyncIterable<MessageStreamEvent> {
        return messageStream(
          {
            events: (sessionId, after) => agent.sessions.events(sessionId, after === undefined ? undefined : { after }),
            admit: (req) => admitMessage(req),
            get: (sessionId, messageId) => agent.messages.get({ sessionId, messageId }),
            entry: async (sessionId, entryId) => {
              const live = requireSession(sessionId);
              const all = await getSessionEntries(live);
              const found = all.find((entry) => entry.id === entryId);
              if (found === undefined) throw agentError("not_found", `entry "${entryId}" not found`);
              return found;
            },
            entries: (sessionId, opts) => agent.sessions.entries(sessionId, opts),
          },
          request,
          streamOptions?.signal,
        );
      },

      async get(key: MessageKey, getOptions?: { wait?: number; signal?: AbortSignal }): Promise<Message> {
        validateWait(getOptions?.wait);
        if (getOptions?.signal?.aborted) throw getOptions.signal.reason;
        const live = requireSession(key.sessionId);
        let messageId: string | undefined;
        if ("messageId" in key) {
          messageId = key.messageId;
        } else {
          const validKey = decodeIdempotencyKey(key.idempotencyKey);
          messageId = validKey !== undefined ? messagesByKey.get(live.meta.id)?.get(validKey) : undefined;
        }
        if (messageId === undefined || getStoredMessage(live.meta.id, messageId) === undefined) {
          throw agentError("not_found", "message not found");
        }
        return waitForMessage(live, messageId, getOptions?.wait, getOptions?.signal);
      },
    },

    busy(): boolean {
      for (const live of liveSessions.values()) {
        if (
          live.dshAgent?.status === "running" ||
          live.activeTurnMessageIds.length > 0 ||
          live.queuedMessages.length > 0 ||
          live.pendingSettlement !== undefined
        ) {
          return true;
        }
      }
      return false;
    },

    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      for (const live of liveSessions.values()) {
        for (const watcher of [...live.watchers]) watcher.end();
        live.watchers.clear();
        if (live.dshAgent !== undefined) {
          if (live.dshAgent.status === "running") {
            live.dshAgent.cancel({ kind: "disposed" }, { keepInbox: true });
          }
          await live.dshAgent.whenIdle().catch(() => {});
          await live.pendingSettlement?.catch(() => {});
          await ctx.sessions.flush(live.dshAgent.session).catch(() => {});
        }
        live.instructionsDisposer?.();
        live.toolsDisposer?.();
        await live.dshHandle?.dispose().catch(() => {});
      }
      await store.flush().catch(() => {});
      await ctx.fiber.dispose();
    },
  };

  return agent;
}
