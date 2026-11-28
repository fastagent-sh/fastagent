/**
 * Live session runtime state, event channels, persistence helpers, and snapshot projection for
 * `@fastagent-sh/harness-dsh`.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent as DshLoopAgent, AgentHandle } from "@deepseek-ai/dsh-agent";
import type { SessionEvent as DshSessionEventRecord } from "@deepseek-ai/dsh-session";
import {
  type ActiveTool,
  type AgentErrorData,
  type Message,
  type QueuedMessage,
  type Session,
  type SessionEvent,
  SessionId,
  agentError,
} from "@fastagent-sh/client/agent-api";
import type { EventChannelWatcher, PortableTool } from "@fastagent-sh/fastagent/harness";
import { deriveContextUsage } from "./projection.ts";
import type { DshEventStoreBackend, DshHarnessOptions, DshStoredMessage, DshStoredSession } from "./types.ts";

export interface SequencedEvent {
  readonly seq: number;
  readonly event: SessionEvent;
}

type Watcher = EventChannelWatcher<SequencedEvent>;

export interface Waiter {
  resolve(message: Message): void;
  reject(error: unknown): void;
}

export interface LiveSession {
  meta: DshStoredSession;
  dshAgent?: DshLoopAgent;
  dshHandle?: AgentHandle;
  instructionsDisposer?: (() => void) | undefined;
  toolsDisposer?: (() => void) | undefined;
  watchers: Set<Watcher>;
  waiters: Map<string, Set<Waiter>>;
  eventSeq: number;
  pendingSettlement?: Promise<void> | undefined;
  bufferedEvents: SessionEvent[];
  storageErrored: boolean;
  toolNamesByCallId: Map<string, string>;
  costBySeq: Map<number, number>;
  pendingCosts: number[];
  liveReply: { active: boolean; text: string; thinking: string };
  activeTools: Map<string, ActiveTool>;
  activeTurnMessageIds: string[];
  queuedMessages: QueuedMessage[];
  lastAnswerInTurn?: { readonly entryId: string; readonly text: string } | undefined;
  retryCounts: Map<string, number>;
  cancelRequested: boolean;
  hitStepLimit: boolean;
  compacting: boolean;
  admitChain: Promise<void>;
  deleteLock?: Promise<void>;
}

/** Shared mutable runtime state owned by `openDshAgent` and passed to sibling runtime modules. */
export interface DshRuntimeState {
  readonly options: DshHarnessOptions;
  readonly ctx: Context;
  readonly store: DshEventStoreBackend;
  readonly toolsByName: Map<string, PortableTool>;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly liveSessions: Map<string, LiveSession>;
  readonly allMessages: Map<string, Map<string, DshStoredMessage>>;
  readonly messagesByKey: Map<string, Map<string, string>>;
  nextSessionOrder: number;
  closing: boolean;
}

export function createLiveSession(meta: DshStoredSession, dshHandle?: AgentHandle): LiveSession {
  return {
    meta,
    ...(dshHandle !== undefined ? { dshAgent: dshHandle.agent, dshHandle } : {}),
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
    hitStepLimit: false,
    compacting: false,
    admitChain: Promise.resolve(),
  };
}

export function emitNow(live: LiveSession, event: SessionEvent): void {
  const seq = ++live.eventSeq;
  for (const watcher of live.watchers) watcher.push({ seq, event });
}

export function broadcast(live: LiveSession, event: SessionEvent): void {
  if (live.pendingSettlement !== undefined) {
    live.bufferedEvents.push(event);
    return;
  }
  emitNow(live, event);
}

export function failSessionWatchersAndWaiters(
  liveSessions: ReadonlyMap<string, LiveSession>,
  sessionId: string | undefined,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const errData: AgentErrorData = { code: "unavailable", message, retryable: true };
  const targets = sessionId !== undefined ? [liveSessions.get(sessionId)].filter(Boolean) : [...liveSessions.values()];
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
}

export async function persistSessionMeta(state: DshRuntimeState, meta: DshStoredSession): Promise<void> {
  if (state.store.putSessionMeta !== undefined) {
    await state.store.putSessionMeta(meta);
  }
}

export async function persistMessage(state: DshRuntimeState, stored: DshStoredMessage): Promise<void> {
  let bySession = state.allMessages.get(stored.sessionId);
  if (bySession === undefined) {
    bySession = new Map();
    state.allMessages.set(stored.sessionId, bySession);
  }
  bySession.set(stored.id, stored);
  if (stored.idempotencyKey !== undefined) {
    let keys = state.messagesByKey.get(stored.sessionId);
    if (keys === undefined) {
      keys = new Map();
      state.messagesByKey.set(stored.sessionId, keys);
    }
    keys.set(stored.idempotencyKey, stored.id);
  }
  if (state.store.putMessage !== undefined) {
    await state.store.putMessage(stored);
  }
}

export function getStoredMessage(
  state: DshRuntimeState,
  sessionId: string,
  messageId: string,
): DshStoredMessage | undefined {
  return state.allMessages.get(sessionId)?.get(messageId);
}

export function notifyMessageSettled(live: LiveSession, message: Message): void {
  const waiters = live.waiters.get(message.id);
  if (waiters !== undefined) {
    for (const waiter of [...waiters]) waiter.resolve(message);
    waiters.clear();
    live.waiters.delete(message.id);
  }
}

export function requireSession(state: DshRuntimeState, sessionId: string): LiveSession {
  const live = state.liveSessions.get(sessionId);
  if (live === undefined || live.meta.deleted) {
    throw agentError("not_found", `session "${sessionId}" not found`);
  }
  return live;
}

export async function readSessionRawEvents(
  state: DshRuntimeState,
  live: LiveSession,
): Promise<readonly DshSessionEventRecord[]> {
  if (live.dshAgent !== undefined) {
    return live.dshAgent.session.snapshotEvents();
  }
  const handle = await state.store.open(live.meta.id, "read");
  try {
    const { events } = await handle.read();
    return events as unknown as readonly DshSessionEventRecord[];
  } finally {
    await handle.close();
  }
}

export function buildSessionSnapshotFromEvents(
  state: DshRuntimeState,
  live: LiveSession,
  rawEvents: readonly DshSessionEventRecord[],
): Session {
  const contextUsage = deriveContextUsage(rawEvents, state.options.models, live.meta.inheritedContextUsage);
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
    id: SessionId.make(live.meta.id),
    status: isRunning ? "running" : "idle",
    ...(live.meta.title !== undefined ? { title: live.meta.title } : {}),
    createdAt: live.meta.createdAt,
    updatedAt: live.meta.updatedAt,
    ...(live.meta.model !== undefined ? { model: live.meta.model } : {}),
    ...(live.meta.thinkingLevel !== undefined ? { thinkingLevel: live.meta.thinkingLevel } : {}),
    ...(live.meta.instructions !== undefined ? { instructions: live.meta.instructions } : {}),
    ...(live.meta.tools !== undefined ? { tools: [...live.meta.tools] } : {}),
    ...(live.meta.maxSteps !== undefined ? { maxSteps: live.meta.maxSteps } : {}),
    ...(reply !== undefined ? { reply } : {}),
    ...(activeTools !== undefined ? { activeTools } : {}),
    ...(queuedMessages !== undefined ? { queuedMessages } : {}),
    ...(live.compacting ? { compacting: true } : {}),
    ...(contextUsage !== undefined ? { contextUsage } : {}),
    usage: structuredClone(live.meta.usage),
  };
}

export async function buildSessionSnapshot(state: DshRuntimeState, live: LiveSession): Promise<Session> {
  const rawEvents = await readSessionRawEvents(state, live);
  return buildSessionSnapshotFromEvents(state, live, rawEvents);
}

export async function pushStateSnapshot(state: DshRuntimeState, live: LiveSession): Promise<void> {
  if (live.watchers.size === 0) return;
  const session = await buildSessionSnapshot(state, live);
  broadcast(live, { type: "state", session });
}
