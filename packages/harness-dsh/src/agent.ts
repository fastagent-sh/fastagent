/**
 * Live FastAgent runtime over DeepSeek Harness (`@deepseek-ai/dsh`).
 * Bootstraps the isolated Cordis `Context` with core DSH plugins, delegates session state,
 * event bridging, and crash recovery to sibling modules, and exposes the `DshAgent` API.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { type Agent as DshLoopAgent, AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import {
  type SessionEvent as DshSessionEventRecord,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  SessionStore,
  buildForkSeed,
} from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { NativeToolExecutor } from "@deepseek-ai/dsh-tool-executor-native";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import {
  AgentError,
  type AgentErrorData,
  type AgentInfo,
  type CreateSessionOptions,
  type EntriesOptions,
  type Entry,
  type ListOptions,
  type Message,
  type MessageKey,
  type MessageStreamEvent,
  type Page,
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
import { applyScopedSettings, bindDshAgentEvents, ensureDshAgent } from "./event-bridge.ts";
import { PiAiModelsAdapter } from "./llm-pi-ai.ts";
import { admitMessage, waitForMessage } from "./message-admission.ts";
import { MemoryDshEventStore, createDshPersistencePlugin } from "./persistence.ts";
import {
  deriveContextUsage,
  emptyUsage,
  mergeUsages,
  paginateEntries,
  projectSessionLog,
  seqForEntryId,
  toPublicMessage,
} from "./projection.ts";
import { restoreAndRecoverSessions } from "./recovery.ts";
import { buildDshSandboxPolicy } from "./sandbox.ts";
import {
  type DshRuntimeState,
  type LiveSession,
  broadcast,
  buildSessionSnapshot,
  buildSessionSnapshotFromEvents,
  createEventChannel,
  createLiveSession,
  failSessionWatchersAndWaiters,
  getStoredMessage,
  notifyMessageSettled,
  persistMessage,
  persistSessionMeta,
  pushStateSnapshot,
  readSessionRawEvents,
  requireSession,
} from "./session-state.ts";
import { leavableIterator, messageStream } from "@fastagent-sh/client/stream";
import { bridgeDshRuntimeTool, validateFastAgentTool } from "./tools.ts";
import type {
  DshAgent,
  DshEventStoreBackend,
  DshHarnessOptions,
  DshStoredMessage,
  DshStoredSession,
  FastAgentToolLike,
} from "./types.ts";
import {
  DEFAULT_THINKING_LEVELS,
  decodeIdempotencyKey,
  makeAgentOptions,
  validateThinkingLevel,
  validateTitle,
  validateWait,
} from "./validation.ts";

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
  for (const tool of userTools) validateFastAgentTool(tool);
  const codingToolNames = new Set<string>(enabledCodingTools);
  for (const tool of userTools) {
    if (codingToolNames.has(tool.name)) {
      throw agentError("invalid_request", `duplicate tool name "${tool.name}" conflicts with built-in coding tool`);
    }
  }

  const store: DshEventStoreBackend = options.storage ?? new MemoryDshEventStore();
  const commandsOf = () => options.commands?.() ?? [];
  const ctx = new Context();
  const state: DshRuntimeState = {
    options,
    ctx,
    store,
    toolsByName: new Map<string, FastAgentToolLike>(),
    maxRetries: options.retry?.maxRetries ?? 1,
    baseDelayMs: options.retry?.baseDelayMs ?? 1,
    liveSessions: new Map<string, LiveSession>(),
    allMessages: new Map<string, Map<string, DshStoredMessage>>(),
    messagesByKey: new Map<string, Map<string, string>>(),
    nextSessionOrder: 1,
    closing: false,
  };

  ctx.plugin(SessionStore);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(
    createDshPersistencePlugin(store, (sessionId, error) =>
      failSessionWatchersAndWaiters(state.liveSessions, sessionId, error),
    ),
  );
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
  for (const tool of toolsList) state.toolsByName.set(tool.name, tool);

  if (options.systemPrompt !== undefined) {
    const prompt = options.systemPrompt;
    if (typeof prompt === "function" || prompt.length > 0) {
      ctx.systemPrompt.section({
        name: "fastagent-system",
        order: 10,
        text: typeof prompt === "function" ? () => prompt() ?? "" : prompt,
        interpolate: false,
      });
    }
  }

  if (options.models !== undefined) {
    const providerIds = options.models.getProviders().map((provider) => provider.id);
    if (providerIds.length > 0) {
      const adapter = new PiAiModelsAdapter(options.models, {
        resolveAttachment: async (sessionId, ref) => store.getAttachment?.(sessionId, ref),
        onCallCost: (sessionId, record) => {
          if (sessionId === undefined) return;
          const live = state.liveSessions.get(sessionId);
          if (live !== undefined) live.pendingCosts.push(record.cost);
        },
        ...(options.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
      });
      ctx.llm.registerAdapter(providerIds, adapter);
    }
  }

  const toolRuntime = {
    toolsByName: state.toolsByName,
    ...(options.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
    onProgress: (progress: { sessionId: string; toolCallId: string; text: string; output?: string }) => {
      const live = state.liveSessions.get(progress.sessionId);
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

  await restoreAndRecoverSessions(state);

  const getSessionEntries = async (live: LiveSession): Promise<Entry[]> => {
    const rawEvents = await readSessionRawEvents(state, live);
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
        ...(options.unusableDefault !== undefined ? { unusableDefault: options.unusableDefault } : {}),
      };
    },

    async usage(): Promise<Usage> {
      return mergeUsages([...state.liveSessions.values()].map((live) => live.meta.usage));
    },

    sessions: {
      async create(createOptions: CreateSessionOptions = {}): Promise<Session> {
        const title = createOptions.title !== undefined ? validateTitle(createOptions.title) : undefined;
        const thinkingLevel =
          createOptions.thinkingLevel !== undefined ? validateThinkingLevel(createOptions.thinkingLevel) : undefined;
        if (createOptions.tools !== undefined) {
          const invalid = createOptions.tools.filter((name) => !state.toolsByName.has(name));
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
          const sourceLive = requireSession(state, createOptions.forkFrom.sessionId);
          const sourceEvents = await readSessionRawEvents(state, sourceLive);
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
          order: state.nextSessionOrder++,
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

        const live = createLiveSession(meta, handle);
        state.liveSessions.set(sessionId, live);
        bindDshAgentEvents(state, live, handle.agent);
        applyScopedSettings(state, live);
        await persistSessionMeta(state, meta);
        return buildSessionSnapshot(state, live);
      },

      async get(sessionId: string): Promise<Session> {
        return buildSessionSnapshot(state, requireSession(state, sessionId));
      },

      async list(listOptions: ListOptions = {}): Promise<Page<Session>> {
        const limit = listOptions.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          throw agentError("invalid_request", `limit must be between 1 and 500, got ${String(limit)}`);
        }
        const ordered = [...state.liveSessions.values()]
          .filter((live) => !live.meta.deleted)
          .sort((a, b) => b.meta.order - a.meta.order);
        let start = 0;
        if (listOptions.after !== undefined) {
          const idx = ordered.findIndex((live) => live.meta.id === listOptions.after);
          if (idx === -1) throw agentError("not_found", `unknown session cursor "${listOptions.after}"`);
          start = idx + 1;
        }
        const slice = ordered.slice(start, start + limit);
        const data = await Promise.all(slice.map((live) => buildSessionSnapshot(state, live)));
        const hasNext = start + slice.length < ordered.length;
        return {
          data,
          ...(hasNext && data.at(-1) !== undefined ? { next: data.at(-1)?.id } : {}),
        };
      },

      async update(sessionId: string, changes: SessionChanges): Promise<Session> {
        const live = requireSession(state, sessionId);
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
            const invalid = changes.tools.filter((name) => !state.toolsByName.has(name));
            if (invalid.length > 0) {
              throw agentError("invalid_request", `unknown tools: ${invalid.join(", ")}`, { tools: invalid });
            }
            nextMeta = { ...nextMeta, tools: [...changes.tools] };
          }
        }

        nextMeta = { ...nextMeta, updatedAt: Date.now() };
        live.meta = nextMeta;
        applyScopedSettings(state, live);
        await persistSessionMeta(state, nextMeta);
        const snapshot = await buildSessionSnapshot(state, live);
        broadcast(live, { type: "state", session: snapshot });
        return snapshot;
      },

      async delete(sessionId: string): Promise<void> {
        const live = state.liveSessions.get(sessionId);
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
          await persistSessionMeta(state, live.meta);
          state.liveSessions.delete(sessionId);
          await live.dshHandle?.dispose().catch(() => {});
        })();
        await live.deleteLock;
      },

      async entries(sessionId: string, entriesOptions?: EntriesOptions): Promise<Page<Entry>> {
        const live = requireSession(state, sessionId);
        const all = await getSessionEntries(live);
        return paginateEntries(all, entriesOptions);
      },

      async attachment(sessionId: string, ref: string): Promise<{ mimeType: string; data: Uint8Array }> {
        requireSession(state, sessionId);
        const found = await store.getAttachment?.(sessionId, ref);
        if (found === undefined || found.sessionId !== sessionId) {
          throw agentError("not_found", `attachment "${ref}" not found`);
        }
        return { mimeType: found.mimeType, data: found.data };
      },

      async cancel(sessionId: string): Promise<{ stopped: string[] }> {
        const live = requireSession(state, sessionId);
        const runningIds = [...live.activeTurnMessageIds];
        const queuedIds = live.queuedMessages.map((q) => q.id);
        if (runningIds.length === 0 && queuedIds.length === 0) {
          return { stopped: [] };
        }
        live.cancelRequested = true;
        live.queuedMessages = [];
        live.dshAgent?.cancel({ kind: "user" });

        for (const msgId of queuedIds) {
          const existing = getStoredMessage(state, live.meta.id, msgId);
          if (existing !== undefined && !hasEnded(existing)) {
            const canceled: DshStoredMessage = {
              ...existing,
              status: "canceled",
              updatedAt: Date.now(),
            };
            await persistMessage(state, canceled);
            const pub = toPublicMessage(canceled);
            broadcast(live, { type: "done", message: pub });
            notifyMessageSettled(live, pub);
          }
        }

        return { stopped: [...runningIds, ...queuedIds] };
      },

      async compact(sessionId: string, compactOptions?: { instructions?: string }): Promise<void> {
        const live = requireSession(state, sessionId);
        const dshAgent = await ensureDshAgent(state, live);
        live.compacting = true;
        broadcast(live, { type: "compaction_started", trigger: "manual" });
        await pushStateSnapshot(state, live);

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
          await persistSessionMeta(state, live.meta);
        } catch (error) {
          broadcast(live, {
            type: "compaction_failed",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          live.compacting = false;
          await pushStateSnapshot(state, live);
        }
      },

      events(sessionId: string, eventOptions?: { after?: string; signal?: AbortSignal }): AsyncIterable<SessionEvent> {
        let cleanup = () => {};
        async function* stream(): AsyncGenerator<SessionEvent> {
          const live = requireSession(state, sessionId);
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
            rawEvents = await readSessionRawEvents(state, live);
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
          const snapshot = buildSessionSnapshotFromEvents(state, live, rawEvents);

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
        const { message } = await admitMessage(state, request, commandsOf());
        const live = state.liveSessions.get(message.sessionId);
        if (live === undefined) return message;
        return waitForMessage(state, live, message.id, sendOptions?.wait, sendOptions?.signal);
      },

      stream(request: SendRequest, streamOptions?: { signal?: AbortSignal }): AsyncIterable<MessageStreamEvent> {
        return messageStream(
          {
            events: (sessionId, after) => agent.sessions.events(sessionId, after === undefined ? undefined : { after }),
            admit: (req) => admitMessage(state, req, commandsOf()),
            get: (sessionId, messageId) => agent.messages.get({ sessionId, messageId }),
            entry: async (sessionId, entryId) => {
              const live = requireSession(state, sessionId);
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
        const live = requireSession(state, key.sessionId);
        let messageId: string | undefined;
        if ("messageId" in key) {
          messageId = key.messageId;
        } else {
          const validKey = decodeIdempotencyKey(key.idempotencyKey);
          messageId = validKey !== undefined ? state.messagesByKey.get(live.meta.id)?.get(validKey) : undefined;
        }
        if (messageId === undefined || getStoredMessage(state, live.meta.id, messageId) === undefined) {
          throw agentError("not_found", "message not found");
        }
        return waitForMessage(state, live, messageId, getOptions?.wait, getOptions?.signal);
      },
    },

    busy(): boolean {
      for (const live of state.liveSessions.values()) {
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
      if (state.closing) return;
      state.closing = true;
      for (const live of state.liveSessions.values()) {
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
