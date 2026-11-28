/**
 * Harness-neutral serving-layer interrupt coordinator (`awaiting_approval` / `input_required`).
 * Wraps portable tools and any `HarnessProvider` runtime agent so every harness gets identical
 * durable approval/input parking, `busy() === false` scale-to-zero hibernation, and replica resume.
 */
import { randomUUID } from "node:crypto";
import {
  type Agent,
  type ContentPart,
  EntriesOptions,
  type Entry,
  IdempotencyKey,
  InterruptId,
  type Json,
  LIMITS,
  type Message,
  MessageId,
  MessageKey,
  type MessageStatus,
  type Page,
  ResolveInterruptRequest,
  SendRequest,
  type SessionEvent,
  SessionId,
  Wait,
  type WaitOptions,
  agentError,
  decodeRequest,
  errorData,
  hasEnded,
  isAwaitingAction,
} from "@fastagent-sh/client/agent-api";
import { leavableIterator, messageStream } from "@fastagent-sh/client/stream";
import { type WorkTracker, createWorkTracker } from "./busy.ts";
import { createEventChannel, type EventChannelWatcher } from "./harness.ts";
import type { Unfinished } from "./harnesses/assembly.ts";
import {
  type PortableTool,
  REQUEST_TOOL_INPUT,
  type ToolExecutionApi,
  type ToolExecutionContext,
  compileToolSchema,
  retainToolOutput,
  sessionIdOf,
  toolCallIdOf,
} from "./harnesses/tool.ts";
import {
  CONTINUATION_HEADER,
  type InterruptStore,
  type RewrittenToolResult,
  type SessionInterruptState,
  type StagedInterruptItem,
  type StoredInterruptItem,
  type StoredInterruptMessage,
  type StoredQueuedSend,
  applyEntryProjection,
  emptySessionState,
  formatContinuationPrompt,
  memoryInterruptStore,
  normalizeApprovalDecision,
  overlaySession,
  parkedStatusOf,
  postgresInterruptStore,
  sqliteInterruptStore,
  toPublicInterruptMessage,
  validateResolutionPayload,
} from "./interrupt-store.ts";
import { log } from "./log.ts";

export { memoryInterruptStore, postgresInterruptStore, sqliteInterruptStore, type InterruptStore };

const EXECUTING_RESOLVED_TOOL: unique symbol = Symbol.for("@fastagent-sh/fastagent/executingResolvedTool");

class ToolParkedSignal {
  readonly item: StagedInterruptItem;
  constructor(item: StagedInterruptItem) {
    this.item = item;
  }
}

interface ActiveAttempt {
  readonly sessionId: SessionId;
  outerMessageId?: MessageId;
  innerMessageId?: MessageId;
  pendingOutcome?: RewrittenToolResult;
  readonly staged: StagedInterruptItem[];
  readonly stagedToolCallIds: Set<string>;
  readonly parkReady: PromiseWithResolvers<readonly SessionEvent[] | undefined>;
}

interface MessageWaiter {
  resolve(message: Message): void;
  reject(error: unknown): void;
}

export interface InterruptRuntimeHandle {
  wrapTools(tools: readonly PortableTool[]): PortableTool[];
  wrapAgent<T extends Agent & { busy(): boolean; close(): Promise<void> }>(inner: T): T;
}

const makeParkReady = () => Promise.withResolvers<readonly SessionEvent[] | undefined>();

export async function createInterruptCoordinator(options: {
  readonly store: InterruptStore;
  readonly work?: WorkTracker;
  readonly unfinished?: Unfinished;
}): Promise<InterruptRuntimeHandle> {
  const { store } = options;
  const work = options.work ?? createWorkTracker();
  const states = new Map<string, SessionInterruptState>();
  const toolsByName = new Map<string, PortableTool>();
  const activeAttempts = new Map<string, ActiveAttempt>();
  const attemptsByInnerId = new Map<string, ActiveAttempt>();
  const sessionLocks = new Map<string, Promise<void>>();
  const extraWatchers = new Map<string, Set<EventChannelWatcher<SessionEvent>>>();
  const waiters = new Map<string, Set<MessageWaiter>>();
  const activeCancelControllers = new Map<string, AbortController>();
  let innerAgent: (Agent & { busy(): boolean; close(): Promise<void> }) | undefined;
  let closed = false;

  for (const loaded of await store.list()) {
    states.set(loaded.sessionId, loaded);
  }

  if (options.unfinished === "refuse") {
    const unfinishedSessions = [...states.values()].filter(
      (s) => s.activeMessageId !== undefined || s.queued.length > 0,
    );
    if (unfinishedSessions.length > 0) {
      const list = unfinishedSessions.map((s) => s.sessionId).join(", ");
      throw new Error(
        `the storage holds ${unfinishedSessions.length} session(s) with parked or queued interrupt work (sessions: ${list}), which this process would not finish: serve the agent until they end, then try again`,
      );
    }
  }

  const withSessionLock = async <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(
      () => current,
      () => current,
    );
    sessionLocks.set(sessionId, chained);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (sessionLocks.get(sessionId) === chained) sessionLocks.delete(sessionId);
    }
  };

  const emitExtra = (sessionId: string, event: SessionEvent): void => {
    const set = extraWatchers.get(sessionId);
    if (set === undefined) return;
    for (const watcher of [...set]) watcher.push(event);
  };

  const notifyWaiters = (message: Message): void => {
    if (!hasEnded(message) && !isAwaitingAction(message)) return;
    const set = waiters.get(message.id);
    if (set === undefined) return;
    for (const waiter of [...set]) waiter.resolve(message);
  };

  const rejectSessionWaiters = (sessionId: string, error: unknown): void => {
    const state = states.get(sessionId);
    if (state === undefined) return;
    for (const msgId of Object.keys(state.messages)) {
      const set = waiters.get(msgId);
      if (set !== undefined) {
        for (const waiter of [...set]) waiter.reject(error);
        set.clear();
        waiters.delete(msgId);
      }
    }
  };

  const saveState = async (next: SessionInterruptState): Promise<void> => {
    await store.put(next);
    states.set(next.sessionId, next);
  };

  const requireInner = (): Agent & { busy(): boolean; close(): Promise<void> } => {
    if (innerAgent === undefined) throw new Error("Interrupt coordinator agent not initialized");
    return innerAgent;
  };

  const collectToolResultIds = async (
    sessionId: string,
    afterEntryId: string | undefined,
    callIds: ReadonlySet<string>,
  ): Promise<string[]> => {
    const page = await requireInner().sessions.entries(sessionId, {
      ...(afterEntryId === undefined ? {} : { after: afterEntryId }),
      limit: 100,
    });
    return page.data
      .filter((entry) => {
        if (entry.kind !== "tool_result") return false;
        const callId = (entry.data as { toolCallId?: unknown } | null)?.toolCallId;
        return typeof callId === "string" && callIds.has(callId);
      })
      .map((entry) => entry.id);
  };

  const monitorInnerRun = async (params: {
    readonly sessionId: SessionId;
    readonly outerMessage: StoredInterruptMessage;
    readonly innerMessageId: MessageId;
    readonly attempt: ActiveAttempt;
    readonly outcomesToProject?: readonly RewrittenToolResult[];
  }): Promise<void> => {
    const { sessionId, outerMessage, innerMessageId, attempt, outcomesToProject } = params;
    attempt.innerMessageId = innerMessageId;
    attemptsByInnerId.set(innerMessageId, attempt);
    const agent = requireInner();
    let settledInner: Message;
    try {
      for (;;) {
        settledInner = await agent.messages.get({ sessionId, messageId: innerMessageId }, { wait: 60 });
        if (hasEnded(settledInner) || closed) break;
      }
      if (!hasEnded(settledInner)) {
        attempt.parkReady.resolve(undefined);
        return;
      }
    } catch (error) {
      attempt.parkReady.resolve(undefined);
      activeAttempts.delete(sessionId);
      log.warn(`[fastagent] interrupt monitor failed for session ${sessionId}: ${String(error)}`);
      return;
    }

    await withSessionLock(sessionId, async () => {
      try {
        const currentState = states.get(sessionId) ?? emptySessionState(sessionId);
        const existingOuter = currentState.messages[outerMessage.id] ?? outerMessage;
        const hiddenEntryIds = [...currentState.hiddenEntryIds];
        let rewrittenEntries = { ...currentState.rewrittenEntries };

        if (outcomesToProject !== undefined && outcomesToProject.length > 0 && settledInner.entryId !== undefined) {
          const primary = outcomesToProject.at(-1);
          if (primary !== undefined) {
            rewrittenEntries = { ...rewrittenEntries, [settledInner.entryId]: primary };
          }
        }

        const entryId = existingOuter.entryId ?? settledInner.entryId;

        if (attempt.staged.length > 0 && settledInner.status !== "canceled") {
          const placeholderIds = await collectToolResultIds(sessionId, settledInner.entryId, attempt.stagedToolCallIds);
          for (const pid of placeholderIds) {
            if (!hiddenEntryIds.includes(pid)) hiddenEntryIds.push(pid);
          }
          const items: StoredInterruptItem[] = attempt.staged.map((staged) => ({
            interrupt: {
              id: staged.id,
              sessionId,
              messageId: existingOuter.id,
              kind: staged.kind,
              toolCallId: staged.toolCallId,
              toolName: staged.toolName,
              summary: staged.summary,
              ...(staged.args === undefined ? {} : { args: staged.args }),
              ...(staged.inputSchema === undefined ? {} : { inputSchema: staged.inputSchema }),
              createdAt: staged.createdAt,
            },
            rawArgs: staged.rawArgs,
            state: { status: "pending" },
          }));
          const parkedMsg: StoredInterruptMessage = {
            id: existingOuter.id,
            sessionId,
            ...(existingOuter.idempotencyKey === undefined ? {} : { idempotencyKey: existingOuter.idempotencyKey }),
            ...(existingOuter.metadata === undefined ? {} : { metadata: existingOuter.metadata }),
            ...(entryId === undefined ? {} : { entryId }),
            phase: "parked",
            status: parkedStatusOf(items),
            items,
            createdAt: existingOuter.createdAt,
            updatedAt: Date.now(),
          };
          const nextState: SessionInterruptState = {
            ...currentState,
            messages: { ...currentState.messages, [parkedMsg.id]: parkedMsg },
            activeMessageId: parkedMsg.id,
            hiddenEntryIds,
            rewrittenEntries,
          };
          const rawSessionBeforeSave = await agent.sessions.get(sessionId);
          await saveState(nextState);
          const snap = overlaySession(rawSessionBeforeSave, nextState);
          activeAttempts.delete(sessionId);
          attempt.parkReady.resolve([
            ...items.map((item): SessionEvent => ({ type: "interrupt_requested", interrupt: item.interrupt })),
            { type: "state", session: snap },
          ]);
          notifyWaiters(toPublicInterruptMessage(parkedMsg));
          return;
        }

        activeAttempts.delete(sessionId);
        if (states.has(sessionId) || outcomesToProject !== undefined) {
          const finalMsg: StoredInterruptMessage = {
            id: existingOuter.id,
            sessionId,
            ...(existingOuter.idempotencyKey === undefined ? {} : { idempotencyKey: existingOuter.idempotencyKey }),
            ...(existingOuter.metadata === undefined ? {} : { metadata: existingOuter.metadata }),
            ...(entryId === undefined ? {} : { entryId }),
            phase: "settled",
            status: settledInner.status as MessageStatus,
            ...(settledInner.answer === undefined ? {} : { answer: settledInner.answer }),
            ...(settledInner.error === undefined ? {} : { error: settledInner.error }),
            items: [],
            createdAt: existingOuter.createdAt,
            updatedAt: Date.now(),
          };
          const clearedActive = currentState.activeMessageId === finalMsg.id ? undefined : currentState.activeMessageId;
          const nextState: SessionInterruptState = {
            ...currentState,
            messages: { ...currentState.messages, [finalMsg.id]: finalMsg },
            ...(clearedActive === undefined ? {} : { activeMessageId: clearedActive }),
            hiddenEntryIds,
            rewrittenEntries,
          };
          if (clearedActive === undefined) {
            const { activeMessageId: _dropped, ...withoutActive } = nextState;
            await saveState(withoutActive);
          } else {
            await saveState(nextState);
          }
          const pub = toPublicInterruptMessage(finalMsg);
          if (outcomesToProject !== undefined) {
            const snap = overlaySession(await agent.sessions.get(sessionId), states.get(sessionId));
            attempt.parkReady.resolve([
              { type: "done", message: pub },
              { type: "state", session: snap },
            ]);
          } else {
            attempt.parkReady.resolve(undefined);
          }
          notifyWaiters(pub);
          await drainQueuedMessagesLocked(sessionId);
        } else {
          attempt.parkReady.resolve(undefined);
          notifyWaiters(settledInner);
        }
      } catch (error) {
        activeAttempts.delete(sessionId);
        attempt.parkReady.resolve(undefined);
        throw error;
      }
    });
  };

  const dispatchAdmittedSendLocked = async (request: SendRequest): Promise<{ message: Message; replayed: boolean }> => {
    const agent = requireInner();
    const sessionId = SessionId.make(request.sessionId);
    const existingState = states.get(sessionId);
    if (request.idempotencyKey !== undefined && existingState !== undefined) {
      const prior = Object.values(existingState.messages).find((m) => m.idempotencyKey === request.idempotencyKey);
      if (prior !== undefined) return { message: toPublicInterruptMessage(prior), replayed: true };
      const queuedPrior = existingState.queued.find((q) => q.request.idempotencyKey === request.idempotencyKey);
      if (queuedPrior !== undefined) {
        return {
          message: {
            id: queuedPrior.id,
            sessionId,
            idempotencyKey: IdempotencyKey.make(request.idempotencyKey),
            ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
            status: "queued",
          },
          replayed: true,
        };
      }
    }

    if (request.idempotencyKey !== undefined) {
      const innerExisting = await agent.messages
        .get({ sessionId, idempotencyKey: IdempotencyKey.make(request.idempotencyKey) })
        .catch((err: unknown) => {
          if ((err as { code?: unknown } | null)?.code === "not_found") return undefined;
          throw err;
        });
      if (innerExisting !== undefined) return { message: innerExisting, replayed: true };
    }

    if (existingState?.activeMessageId !== undefined) {
      const active = existingState.messages[existingState.activeMessageId];
      const whenBusy = request.whenBusy ?? "queue";
      if (whenBusy === "reject") {
        const reason = active?.phase === "parked" ? active.status : "running";
        throw agentError("busy", `Session ${sessionId} is currently ${reason}`, { reason });
      }
      if (existingState.queued.length >= LIMITS.queuedPerSession) {
        throw agentError("busy", `Session ${sessionId} queue is full`, { reason: "queue_full" });
      }
      const queuedId = MessageId.make(`msg_${randomUUID()}`);
      const mode: "steer" | "queue" = whenBusy === "steer" ? "steer" : "queue";
      const queuedEntry: StoredQueuedSend = { id: queuedId, request, mode, createdAt: Date.now() };
      const steers = existingState.queued.filter((q) => q.mode === "steer");
      const queues = existingState.queued.filter((q) => q.mode === "queue");
      const nextQueued = mode === "steer" ? [...steers, queuedEntry, ...queues] : [...steers, ...queues, queuedEntry];
      const queuedMsg: StoredInterruptMessage = {
        id: queuedId,
        sessionId,
        ...(request.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: IdempotencyKey.make(request.idempotencyKey) }),
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        phase: "resuming",
        status: "queued",
        items: [],
        createdAt: queuedEntry.createdAt,
        updatedAt: queuedEntry.createdAt,
      };
      const nextState: SessionInterruptState = {
        ...existingState,
        messages: { ...existingState.messages, [queuedId]: queuedMsg },
        queued: nextQueued,
      };
      await saveState(nextState);
      emitExtra(sessionId, { type: "state", session: overlaySession(await agent.sessions.get(sessionId), nextState) });
      return { message: toPublicInterruptMessage(queuedMsg), replayed: false };
    }

    const attempt: ActiveAttempt = { sessionId, staged: [], stagedToolCallIds: new Set(), parkReady: makeParkReady() };
    activeAttempts.set(sessionId, attempt);
    try {
      const admitted = await agent.messages.send(request);
      attempt.outerMessageId = admitted.id;
      attempt.innerMessageId = admitted.id;
      attemptsByInnerId.set(admitted.id, attempt);
      if (hasEnded(admitted)) {
        activeAttempts.delete(sessionId);
        attemptsByInnerId.delete(admitted.id);
        attempt.parkReady.resolve(undefined);
        return { message: admitted, replayed: false };
      }
      const now = Date.now();
      const outerMsg: StoredInterruptMessage = {
        id: admitted.id,
        sessionId,
        ...(admitted.idempotencyKey === undefined ? {} : { idempotencyKey: admitted.idempotencyKey }),
        ...(admitted.metadata === undefined ? {} : { metadata: admitted.metadata }),
        ...(admitted.entryId === undefined ? {} : { entryId: admitted.entryId }),
        phase: "resuming",
        status: "running",
        items: [],
        activeInnerMessageId: admitted.id,
        createdAt: now,
        updatedAt: now,
      };
      void monitorInnerRun({ sessionId, outerMessage: outerMsg, innerMessageId: admitted.id, attempt });
      return { message: admitted, replayed: false };
    } catch (error) {
      activeAttempts.delete(sessionId);
      attempt.parkReady.resolve(undefined);
      throw error;
    }
  };

  const drainQueuedMessagesLocked = async (sessionId: SessionId): Promise<void> => {
    const state = states.get(sessionId);
    if (state === undefined || state.activeMessageId !== undefined || state.queued.length === 0) return;
    const [next, ...rest] = state.queued;
    if (next === undefined) return;
    const attempt: ActiveAttempt = {
      sessionId,
      outerMessageId: next.id,
      staged: [],
      stagedToolCallIds: new Set(),
      parkReady: makeParkReady(),
    };
    activeAttempts.set(sessionId, attempt);
    try {
      const innerAdmitted = await requireInner().messages.send({
        sessionId,
        content: next.request.content,
        ...(next.request.metadata === undefined ? {} : { metadata: next.request.metadata }),
      });
      const existingOuter = state.messages[next.id];
      const runningOuter: StoredInterruptMessage = {
        id: next.id,
        sessionId,
        ...(next.request.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: IdempotencyKey.make(next.request.idempotencyKey) }),
        ...(next.request.metadata === undefined ? {} : { metadata: next.request.metadata }),
        ...(innerAdmitted.entryId === undefined ? {} : { entryId: innerAdmitted.entryId }),
        phase: "resuming",
        status: "running",
        items: [],
        activeInnerMessageId: innerAdmitted.id,
        createdAt: existingOuter?.createdAt ?? next.createdAt,
        updatedAt: Date.now(),
      };
      await saveState({
        ...state,
        messages: { ...state.messages, [next.id]: runningOuter },
        activeMessageId: next.id,
        queued: rest,
      });
      void monitorInnerRun({ sessionId, outerMessage: runningOuter, innerMessageId: innerAdmitted.id, attempt });
    } catch (error) {
      activeAttempts.delete(sessionId);
      attempt.parkReady.resolve(undefined);
      log.warn(`[fastagent] failed draining queued message ${next.id} on session ${sessionId}: ${String(error)}`);
    }
  };

  const executeResolvedRound = async (sessionId: SessionId, messageId: MessageId): Promise<void> => {
    const doneWork = work.begin();
    const cancelCtrl = new AbortController();
    activeCancelControllers.set(sessionId, cancelCtrl);
    try {
      const outer = states.get(sessionId)?.messages[messageId];
      if (outer === undefined || outer.phase !== "resuming") return;

      const outcomes: RewrittenToolResult[] = [];
      let shouldTerminateImmediately = false;

      for (const item of outer.items) {
        if (cancelCtrl.signal.aborted || closed) return;
        const { toolCallId, toolName } = item.interrupt;
        if (item.state.status === "denied") {
          const reasonSuffix = item.state.reason ? `: ${item.state.reason}` : ".";
          outcomes.push({
            toolCallId,
            toolName,
            isError: true,
            content: [{ type: "text", text: `Tool "${toolName}" was denied by the user${reasonSuffix}` }],
          });
          continue;
        }
        const tool = toolsByName.get(toolName);
        if (tool === undefined) {
          outcomes.push({
            toolCallId,
            toolName,
            isError: true,
            content: [{ type: "text", text: `Tool "${toolName}" is no longer registered on this agent.` }],
          });
          continue;
        }

        let streamedOutput = "";
        let lastLine = "";
        const execContext: ToolExecutionContext = { abortSignal: cancelCtrl.signal, sessionId, toolCallId };
        const execApi: ToolExecutionApi = {
          output(chunk: string) {
            streamedOutput = retainToolOutput(streamedOutput + chunk, tool.outputLimits);
            const lines = streamedOutput
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean);
            const latest = lines.at(-1);
            if (latest !== undefined && latest !== lastLine) {
              lastLine = latest;
              emitExtra(sessionId, {
                type: "tool_progress",
                toolCallId,
                text: latest,
                ...(lines.length > 1 ? { output: streamedOutput.trimEnd() } : {}),
              });
            }
          },
          async executeTool(nestedName, nestedArgs, nestedCtx) {
            const target = toolsByName.get(nestedName);
            if (target === undefined) throw new Error(`Unknown tool: ${nestedName}`);
            const nestedResult = await target.execute(nestedArgs, execApi, {
              abortSignal: nestedCtx?.abortSignal ?? cancelCtrl.signal,
              sessionId: nestedCtx?.sessionId ?? sessionId,
            });
            return { ...(nestedResult.isError === undefined ? {} : { isError: nestedResult.isError }) };
          },
        };
        const submittedInput = item.state.status === "submitted" ? item.state.input : undefined;
        let consumedSubmittedInput = false;
        Object.defineProperty(execApi, EXECUTING_RESOLVED_TOOL, { value: true, enumerable: false });
        Object.defineProperty(execApi, REQUEST_TOOL_INPUT, {
          enumerable: false,
          value: async (reqOptions: { readonly prompt: string; readonly schema?: unknown }) => {
            if (submittedInput !== undefined && !consumedSubmittedInput) {
              consumedSubmittedInput = true;
              if (reqOptions.schema !== undefined) {
                const compiled = compileToolSchema(tool.name, reqOptions.schema);
                if (compiled.validate !== undefined) {
                  const validated = await compiled.validate(submittedInput);
                  if (!validated.ok) throw new Error(`Invalid submitted input: ${validated.message}`);
                  return validated.value;
                }
              }
              return submittedInput;
            }
            const compiledSchema =
              reqOptions.schema === undefined ? undefined : compileToolSchema(tool.name, reqOptions.schema);
            throw new ToolParkedSignal({
              id: InterruptId.make(`int_${randomUUID()}`),
              kind: "input",
              toolCallId,
              toolName,
              summary: reqOptions.prompt.trim() || `Input requested by "${toolName}"`,
              ...(compiledSchema === undefined
                ? {}
                : { inputSchema: compiledSchema.jsonSchema as Record<string, Json> }),
              rawArgs: item.rawArgs,
              createdAt: Date.now(),
            });
          },
        });

        try {
          const result = await tool.execute(item.rawArgs, execApi, execContext);
          if (result.control?.terminate === true) shouldTerminateImmediately = true;
          const explicitParts: ContentPart[] = (result.output ?? []).map((p) => ({ type: "text", text: p.text }));
          const content: ContentPart[] =
            explicitParts.length > 0
              ? explicitParts
              : streamedOutput.trimEnd().length > 0
                ? [{ type: "text", text: streamedOutput.trimEnd() }]
                : [{ type: "text", text: "ok" }];
          outcomes.push({
            toolCallId,
            toolName,
            isError: result.isError === true,
            content,
            ...(result.details === undefined ? {} : { details: result.details as Json }),
          });
        } catch (error) {
          if (cancelCtrl.signal.aborted) return;
          if (error instanceof ToolParkedSignal) {
            await withSessionLock(sessionId, async () => {
              const cur = states.get(sessionId);
              const curMsg = cur?.messages[messageId];
              if (cur === undefined || curMsg === undefined) return;
              const nextItem: StoredInterruptItem = {
                interrupt: {
                  id: error.item.id,
                  sessionId,
                  messageId,
                  kind: error.item.kind,
                  toolCallId: error.item.toolCallId,
                  toolName: error.item.toolName,
                  summary: error.item.summary,
                  ...(error.item.args === undefined ? {} : { args: error.item.args }),
                  ...(error.item.inputSchema === undefined ? {} : { inputSchema: error.item.inputSchema }),
                  createdAt: error.item.createdAt,
                },
                rawArgs: error.item.rawArgs,
                state: { status: "pending" },
              };
              const reParked: StoredInterruptMessage = {
                ...curMsg,
                phase: "parked",
                status: parkedStatusOf([nextItem]),
                items: [nextItem],
                updatedAt: Date.now(),
              };
              const nextState: SessionInterruptState = {
                ...cur,
                messages: { ...cur.messages, [messageId]: reParked },
                activeMessageId: messageId,
              };
              const rawSnap = await requireInner().sessions.get(sessionId);
              await saveState(nextState);
              emitExtra(sessionId, { type: "interrupt_requested", interrupt: nextItem.interrupt });
              emitExtra(sessionId, { type: "state", session: overlaySession(rawSnap, nextState) });
              notifyWaiters(toPublicInterruptMessage(reParked));
            });
            return;
          }
          outcomes.push({
            toolCallId,
            toolName,
            isError: true,
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          });
        }
      }

      if (cancelCtrl.signal.aborted || closed) return;

      if (shouldTerminateImmediately) {
        await withSessionLock(sessionId, async () => {
          const cur = states.get(sessionId);
          const curMsg = cur?.messages[messageId];
          if (cur === undefined || curMsg === undefined) return;
          const completedMsg: StoredInterruptMessage = {
            ...curMsg,
            phase: "settled",
            status: "completed",
            items: [],
            updatedAt: Date.now(),
          };
          const { activeMessageId: _dropped, ...restState } = cur;
          const nextState: SessionInterruptState = {
            ...restState,
            messages: { ...cur.messages, [messageId]: completedMsg },
          };
          const rawSnap = await requireInner().sessions.get(sessionId);
          await saveState(nextState);
          const pub = toPublicInterruptMessage(completedMsg);
          emitExtra(sessionId, { type: "done", message: pub });
          emitExtra(sessionId, { type: "state", session: overlaySession(rawSnap, nextState) });
          notifyWaiters(pub);
          await drainQueuedMessagesLocked(sessionId);
        });
        return;
      }

      const attempt: ActiveAttempt = {
        sessionId,
        outerMessageId: messageId,
        ...(outcomes.at(-1) === undefined ? {} : { pendingOutcome: outcomes.at(-1) as RewrittenToolResult }),
        staged: [],
        stagedToolCallIds: new Set(),
        parkReady: makeParkReady(),
      };
      activeAttempts.set(sessionId, attempt);
      const continuationAdmitted = await requireInner().messages.send({
        sessionId,
        content: formatContinuationPrompt(outcomes),
      });
      attempt.innerMessageId = continuationAdmitted.id;
      attemptsByInnerId.set(continuationAdmitted.id, attempt);
      await withSessionLock(sessionId, async () => {
        const cur = states.get(sessionId);
        const curMsg = cur?.messages[messageId];
        if (cur === undefined || curMsg === undefined) return;
        let rewrittenEntries = { ...cur.rewrittenEntries };
        if (continuationAdmitted.entryId !== undefined && outcomes.at(-1) !== undefined) {
          rewrittenEntries = {
            ...rewrittenEntries,
            [continuationAdmitted.entryId]: outcomes.at(-1) as RewrittenToolResult,
          };
        }
        await saveState({
          ...cur,
          messages: {
            ...cur.messages,
            [messageId]: { ...curMsg, activeInnerMessageId: continuationAdmitted.id, updatedAt: Date.now() },
          },
          rewrittenEntries,
        });
      });
      await monitorInnerRun({
        sessionId,
        outerMessage: outer,
        innerMessageId: continuationAdmitted.id,
        attempt,
        outcomesToProject: outcomes,
      });
    } finally {
      if (activeCancelControllers.get(sessionId) === cancelCtrl) activeCancelControllers.delete(sessionId);
      doneWork();
    }
  };

  const getOuterMessage = async (sessionId: SessionId, messageId: MessageId): Promise<Message> => {
    const stored = states.get(sessionId)?.messages[messageId];
    return stored !== undefined
      ? toPublicInterruptMessage(stored)
      : requireInner().messages.get({ sessionId, messageId });
  };

  const waitForOuterMessage = async (
    key: { readonly sessionId: SessionId; readonly messageId?: MessageId; readonly idempotencyKey?: IdempotencyKey },
    waitOptions?: WaitOptions,
  ): Promise<Message> => {
    const waitSeconds = waitOptions?.wait === undefined ? undefined : decodeRequest(Wait, waitOptions.wait, "wait");
    const signal = waitOptions?.signal;
    if (signal?.aborted) throw signal.reason;

    const resolveCurrent = async (): Promise<Message> => {
      const state = states.get(key.sessionId);
      if (state !== undefined) {
        if (key.messageId !== undefined && state.messages[key.messageId] !== undefined) {
          return toPublicInterruptMessage(state.messages[key.messageId] as StoredInterruptMessage);
        }
        if (key.idempotencyKey !== undefined) {
          const byKey = Object.values(state.messages).find((m) => m.idempotencyKey === key.idempotencyKey);
          if (byKey !== undefined) return toPublicInterruptMessage(byKey);
        }
      }
      if (key.messageId !== undefined) {
        return requireInner().messages.get({ sessionId: key.sessionId, messageId: key.messageId });
      }
      return requireInner().messages.get({
        sessionId: key.sessionId,
        idempotencyKey: key.idempotencyKey as IdempotencyKey,
      });
    };

    const initial = await resolveCurrent();
    if (hasEnded(initial) || isAwaitingAction(initial) || waitSeconds === undefined || waitSeconds <= 0) {
      return initial;
    }
    if (signal?.aborted) throw signal.reason;

    return new Promise<Message>((resolve, reject) => {
      let waiterSet = waiters.get(initial.id);
      if (waiterSet === undefined) {
        waiterSet = new Set();
        waiters.set(initial.id, waiterSet);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiterSet?.delete(waiter);
      };
      const waiter: MessageWaiter = {
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
          void resolveCurrent().then(resolve, reject);
        }, waitSeconds * 1000);
      }
      waiterSet.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });

      if (states.get(key.sessionId)?.messages[initial.id] === undefined) {
        void requireInner()
          .messages.get(
            { sessionId: key.sessionId, messageId: initial.id },
            { wait: waitSeconds, ...(signal ? { signal } : {}) },
          )
          .then((innerMsg) => {
            const doneAttempt = attemptsByInnerId.get(initial.id) ?? activeAttempts.get(key.sessionId);
            if (doneAttempt !== undefined && doneAttempt.staged.length > 0) {
              return doneAttempt.parkReady.promise.then(() => resolveCurrent()).then(waiter.resolve, waiter.reject);
            }
            const afterState = states.get(key.sessionId)?.messages[initial.id];
            waiter.resolve(afterState !== undefined ? toPublicInterruptMessage(afterState) : innerMsg);
          })
          .catch((err) => {
            if (signal?.aborted) waiter.reject(signal.reason);
            else waiter.reject(err);
          });
      }
    });
  };

  const wrapSingleTool = (tool: PortableTool): PortableTool => {
    toolsByName.set(tool.name, tool);
    return {
      ...tool,
      execute: async (rawArgs, api, context) => {
        const isResumedExecution = typeof api === "object" && api !== null && EXECUTING_RESOLVED_TOOL in api;
        const sessionId = await sessionIdOf(api, context);
        const callId = toolCallIdOf(api, context) ?? `call_${randomUUID()}`;

        if (!isResumedExecution && sessionId !== undefined && tool.requiresApproval !== undefined) {
          let parsedArgs: unknown = rawArgs;
          if (tool.validateArguments !== undefined) {
            const checked = await tool.validateArguments(rawArgs);
            if (!checked.ok) {
              return { output: [{ type: "text", text: `Invalid arguments: ${checked.message}` }], isError: true };
            }
            parsedArgs = checked.value;
          }
          const rawDecision =
            typeof tool.requiresApproval === "function"
              ? await tool.requiresApproval(parsedArgs)
              : tool.requiresApproval;
          const normalized = normalizeApprovalDecision(tool.name, rawDecision, parsedArgs);
          if (normalized.required) {
            const interruptId = InterruptId.make(`int_${randomUUID()}`);
            const staged: StagedInterruptItem = {
              id: interruptId,
              kind: "approval",
              toolCallId: callId,
              toolName: tool.name,
              summary: normalized.summary,
              ...(normalized.args === undefined ? {} : { args: normalized.args }),
              rawArgs: structuredClone(rawArgs) as Json,
              createdAt: Date.now(),
            };
            let attempt = activeAttempts.get(sessionId);
            if (attempt === undefined) {
              attempt = { sessionId, staged: [], stagedToolCallIds: new Set(), parkReady: makeParkReady() };
              activeAttempts.set(sessionId, attempt);
            }
            attempt.staged.push(staged);
            attempt.stagedToolCallIds.add(callId);
            return {
              output: [{ type: "text", text: `[Paused awaiting approval (${interruptId}): ${normalized.summary}]` }],
              control: { terminate: true },
            };
          }
        }

        const apiWithInputHook: ToolExecutionApi = isResumedExecution
          ? api
          : Object.defineProperties(Object.create(Object.getPrototypeOf(api ?? {})), {
              ...Object.getOwnPropertyDescriptors(api ?? {}),
              [REQUEST_TOOL_INPUT]: {
                enumerable: false,
                value: async (reqOptions: { readonly prompt: string; readonly schema?: unknown }) => {
                  if (sessionId === undefined) {
                    throw new Error(`tool "${tool.name}" called api.requestInput() outside an active session`);
                  }
                  const compiledSchema =
                    reqOptions.schema === undefined ? undefined : compileToolSchema(tool.name, reqOptions.schema);
                  throw new ToolParkedSignal({
                    id: InterruptId.make(`int_${randomUUID()}`),
                    kind: "input",
                    toolCallId: callId,
                    toolName: tool.name,
                    summary: reqOptions.prompt.trim() || `Input requested by "${tool.name}"`,
                    ...(compiledSchema === undefined
                      ? {}
                      : { inputSchema: compiledSchema.jsonSchema as Record<string, Json> }),
                    rawArgs: structuredClone(rawArgs) as Json,
                    createdAt: Date.now(),
                  });
                },
              },
            });

        try {
          return await tool.execute(rawArgs, apiWithInputHook, context);
        } catch (error) {
          if (error instanceof ToolParkedSignal) {
            if (isResumedExecution) throw error;
            if (sessionId !== undefined) {
              let attempt = activeAttempts.get(sessionId);
              if (attempt === undefined) {
                attempt = { sessionId, staged: [], stagedToolCallIds: new Set(), parkReady: makeParkReady() };
                activeAttempts.set(sessionId, attempt);
              }
              attempt.staged.push(error.item);
              attempt.stagedToolCallIds.add(callId);
            }
            return {
              output: [
                { type: "text", text: `[Paused awaiting user input (${error.item.id}): ${error.item.summary}]` },
              ],
              control: { terminate: true },
            };
          }
          throw error;
        }
      },
    };
  };

  return {
    wrapTools(tools) {
      return tools.map(wrapSingleTool);
    },

    wrapAgent<T extends Agent & { busy(): boolean; close(): Promise<void> }>(inner: T): T {
      innerAgent = inner;

      for (const state of states.values()) {
        if (state.activeMessageId === undefined) continue;
        const active = state.messages[state.activeMessageId];
        if (active === undefined || active.phase !== "resuming") continue;
        if (active.activeInnerMessageId !== undefined) {
          const attempt: ActiveAttempt = {
            sessionId: state.sessionId,
            outerMessageId: active.id,
            innerMessageId: active.activeInnerMessageId,
            staged: [],
            stagedToolCallIds: new Set(),
            parkReady: makeParkReady(),
          };
          activeAttempts.set(state.sessionId, attempt);
          attemptsByInnerId.set(active.activeInnerMessageId, attempt);
          void monitorInnerRun({
            sessionId: state.sessionId,
            outerMessage: active,
            innerMessageId: active.activeInnerMessageId,
            attempt,
          });
        } else {
          const allReplaySafe = active.items.every(
            (item) => item.state.status === "denied" || toolsByName.get(item.interrupt.toolName)?.replay === "safe",
          );
          if (allReplaySafe) {
            void executeResolvedRound(state.sessionId, active.id);
          } else {
            void withSessionLock(state.sessionId, async () => {
              const interruptedOutcomes: RewrittenToolResult[] = active.items.map((item) => ({
                toolCallId: item.interrupt.toolCallId,
                toolName: item.interrupt.toolName,
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Approved tool "${item.interrupt.toolName}" was interrupted by a process restart before completion.`,
                  },
                ],
              }));
              const attempt: ActiveAttempt = {
                sessionId: state.sessionId,
                outerMessageId: active.id,
                ...(interruptedOutcomes.at(-1) === undefined
                  ? {}
                  : { pendingOutcome: interruptedOutcomes.at(-1) as RewrittenToolResult }),
                staged: [],
                stagedToolCallIds: new Set(),
                parkReady: makeParkReady(),
              };
              activeAttempts.set(state.sessionId, attempt);
              const cont = await inner.messages.send({
                sessionId: state.sessionId,
                content: formatContinuationPrompt(interruptedOutcomes),
              });
              void monitorInnerRun({
                sessionId: state.sessionId,
                outerMessage: active,
                innerMessageId: cont.id,
                attempt,
                outcomesToProject: interruptedOutcomes,
              });
            }).catch((err) => log.warn(`[fastagent] interrupted continuation recovery failed: ${String(err)}`));
          }
        }
      }

      const readProjectedEntries = async (sessionId: string, entriesOptions?: EntriesOptions): Promise<Page<Entry>> => {
        const state = states.get(sessionId);
        if (
          state === undefined ||
          (state.hiddenEntryIds.length === 0 && Object.keys(state.rewrittenEntries).length === 0)
        ) {
          return inner.sessions.entries(sessionId, entriesOptions);
        }
        const decoded = decodeRequest(EntriesOptions, entriesOptions ?? {}, "sessions.entries");
        const limit = decoded.limit ?? LIMITS.pageDefault;
        if (decoded.before !== undefined && decoded.after === undefined) {
          const collected: Entry[] = [];
          let cursor: string | undefined = decoded.before;
          let hasPrev = false;
          for (;;) {
            const page = await inner.sessions.entries(sessionId, { before: cursor, limit });
            const projected = page.data.flatMap((e) => {
              const p = applyEntryProjection(e, state);
              return p === undefined ? [] : [p];
            });
            collected.unshift(...projected);
            if (collected.length >= limit || page.prev === undefined) {
              hasPrev = collected.length > limit || page.prev !== undefined;
              break;
            }
            cursor = page.prev;
          }
          const data = collected.slice(-limit);
          return {
            data,
            ...(hasPrev && data[0] !== undefined ? { prev: data[0].id } : {}),
            ...(data.at(-1) !== undefined ? { next: (data.at(-1) as Entry).id } : {}),
          };
        }
        if (decoded.after !== undefined) {
          const collected: Entry[] = [];
          let cursor: string | undefined = decoded.after;
          let hasNext = false;
          for (;;) {
            const page = await inner.sessions.entries(sessionId, { after: cursor, limit });
            const projected = page.data.flatMap((e) => {
              const p = applyEntryProjection(e, state);
              return p === undefined ? [] : [p];
            });
            collected.push(...projected);
            if (collected.length >= limit || page.next === undefined) {
              hasNext = collected.length > limit || page.next !== undefined;
              break;
            }
            cursor = page.next;
          }
          const data = collected.slice(0, limit);
          return {
            data,
            ...(data[0] !== undefined ? { prev: data[0].id } : {}),
            ...(hasNext && data.at(-1) !== undefined ? { next: (data.at(-1) as Entry).id } : {}),
          };
        }
        const rawPage = await inner.sessions.entries(sessionId, {
          limit: Math.min(500, limit + state.hiddenEntryIds.length + 4),
        });
        const projected = rawPage.data.flatMap((e) => {
          const p = applyEntryProjection(e, state);
          return p === undefined ? [] : [p];
        });
        const data = projected.slice(-limit);
        const hasPrev = projected.length > limit || rawPage.prev !== undefined;
        return {
          data,
          ...(hasPrev && data[0] !== undefined ? { prev: data[0].id } : {}),
        };
      };

      const sessionEvents = (
        sessionId: string,
        eventsOptions?: { after?: string; signal?: AbortSignal },
      ): AsyncIterable<SessionEvent> => {
        return {
          [Symbol.asyncIterator]() {
            const innerIter = inner.sessions
              .events(sessionId, { ...(eventsOptions?.after === undefined ? {} : { after: eventsOptions.after }) })
              [Symbol.asyncIterator]();
            const { watcher, iterable: extraIterable } = createEventChannel<SessionEvent>(() => {
              extraWatchers.get(sessionId)?.delete(watcher);
            });
            let watcherSet = extraWatchers.get(sessionId);
            if (watcherSet === undefined) {
              watcherSet = new Set();
              extraWatchers.set(sessionId, watcherSet);
            }
            watcherSet.add(watcher);
            const extraIter = extraIterable[Symbol.asyncIterator]();

            const leave = () => {
              watcherSet?.delete(watcher);
              watcher.end();
              void innerIter.return?.();
              void extraIter.return?.();
            };

            async function* merged(): AsyncGenerator<SessionEvent> {
              try {
                const firstInner = await innerIter.next();
                if (firstInner.done) return;

                type StreamStep = { readonly src: "inner" | "extra"; readonly res: IteratorResult<SessionEvent> };
                let nextInner: Promise<StreamStep> | undefined = Promise.resolve({ src: "inner", res: firstInner });
                let nextExtra: Promise<StreamStep> | undefined = extraIter
                  .next()
                  .then((res): StreamStep => ({ src: "extra", res }));

                while (nextInner !== undefined || nextExtra !== undefined) {
                  const racers: Promise<StreamStep>[] = [
                    ...(nextInner === undefined ? [] : [nextInner]),
                    ...(nextExtra === undefined ? [] : [nextExtra]),
                  ];
                  const winner: StreamStep = await Promise.race(racers);
                  if (winner.src === "inner") {
                    nextInner = winner.res.done
                      ? undefined
                      : innerIter.next().then((res): StreamStep => ({ src: "inner", res }));
                    if (winner.res.done) break;
                    const ev = winner.res.value;
                    if (ev.type === "stream_error") {
                      yield ev;
                      return;
                    }
                    const attempt = activeAttempts.get(sessionId);
                    const state = states.get(sessionId);
                    if (ev.type === "entry") {
                      if (ev.entry.kind === "tool_result") {
                        const callId = (ev.entry.data as { toolCallId?: unknown } | null)?.toolCallId;
                        if (typeof callId === "string" && attempt?.stagedToolCallIds.has(callId)) continue;
                      }
                      if (ev.entry.kind === "user") {
                        const content = (ev.entry.data as { content?: readonly ContentPart[] } | null)?.content;
                        const firstText = content?.[0]?.type === "text" ? content[0].text : "";
                        if (firstText.startsWith(CONTINUATION_HEADER)) {
                          const rewritten =
                            states.get(sessionId)?.rewrittenEntries[ev.entry.id] ?? attempt?.pendingOutcome;
                          if (rewritten !== undefined) {
                            yield {
                              type: "entry",
                              entry: {
                                id: ev.entry.id,
                                timestamp: ev.entry.timestamp,
                                kind: "tool_result",
                                data: {
                                  toolCallId: rewritten.toolCallId,
                                  toolName: rewritten.toolName,
                                  isError: rewritten.isError,
                                  content: rewritten.content.map((p) => ({ ...p })),
                                  ...(rewritten.details === undefined ? {} : { details: rewritten.details }),
                                },
                              },
                            };
                          }
                          continue;
                        }
                      }
                      const projected = applyEntryProjection(ev.entry, state);
                      if (projected !== undefined) yield { type: "entry", entry: projected };
                      continue;
                    }
                    if (ev.type === "done") {
                      const doneAttempt = attemptsByInnerId.get(ev.message.id);
                      if (doneAttempt !== undefined) {
                        const replacementEvents = await doneAttempt.parkReady.promise;
                        attemptsByInnerId.delete(ev.message.id);
                        if (replacementEvents !== undefined) {
                          yield* replacementEvents;
                          continue;
                        }
                      }
                      if (attempt !== undefined && attempt.staged.length > 0) {
                        const replacementEvents = await attempt.parkReady.promise;
                        if (replacementEvents !== undefined) yield* replacementEvents;
                        continue;
                      }
                      const trackedByInner = Object.values(states.get(sessionId)?.messages ?? {}).find(
                        (m) => m.activeInnerMessageId === ev.message.id && m.id !== ev.message.id,
                      );
                      if (trackedByInner !== undefined) continue;
                      const parkedSelf = states.get(sessionId)?.messages[ev.message.id];
                      if (parkedSelf !== undefined && parkedSelf.phase === "parked") continue;
                      yield ev;
                      continue;
                    }
                    if (ev.type === "state") {
                      const pendingDoneForSession = [...attemptsByInnerId.values()].some(
                        (a) => a.sessionId === sessionId && a.staged.length > 0,
                      );
                      if (pendingDoneForSession) {
                        if (ev.session.status !== "idle") yield ev;
                        continue;
                      }
                      yield { type: "state", session: overlaySession(ev.session, states.get(sessionId)) };
                      continue;
                    }
                    yield ev;
                  } else {
                    nextExtra = winner.res.done
                      ? undefined
                      : extraIter.next().then((res): StreamStep => ({ src: "extra", res }));
                    if (winner.res.done) continue;
                    yield winner.res.value;
                  }
                }
              } finally {
                leave();
              }
            }

            return leavableIterator(merged(), leave, eventsOptions?.signal);
          },
        };
      };

      const decorated: T = {
        ...inner,
        busy: () => work.active() > 0 || inner.busy(),
        async close() {
          closed = true;
          for (const ctrl of activeCancelControllers.values()) ctrl.abort();
          activeCancelControllers.clear();
          for (const set of extraWatchers.values()) {
            for (const w of set) w.end();
          }
          extraWatchers.clear();
          await inner.close();
        },
        sessions: {
          ...inner.sessions,
          async get(sessionId) {
            return overlaySession(await inner.sessions.get(sessionId), states.get(sessionId));
          },
          async list(listOptions) {
            const page = await inner.sessions.list(listOptions);
            return { ...page, data: page.data.map((s) => overlaySession(s, states.get(s.id))) };
          },
          async delete(sessionId) {
            activeCancelControllers.get(sessionId)?.abort();
            const deletedErr = agentError("not_found", `Session ${sessionId} was deleted`);
            const set = extraWatchers.get(sessionId);
            if (set !== undefined) {
              for (const w of [...set]) {
                w.push({ type: "stream_error", error: errorData(deletedErr) });
                w.end();
              }
              set.clear();
              extraWatchers.delete(sessionId);
            }
            rejectSessionWaiters(sessionId, deletedErr);
            await inner.sessions.delete(sessionId);
            states.delete(sessionId);
            await store.delete(SessionId.make(sessionId));
          },
          entries: (sessionId, entriesOptions) => readProjectedEntries(sessionId, entriesOptions),
          events: (sessionId, eventsOptions) => sessionEvents(sessionId, eventsOptions),
          async cancel(sessionId) {
            await inner.sessions.get(sessionId);
            activeCancelControllers.get(sessionId)?.abort();
            return withSessionLock(sessionId, async () => {
              const innerCancelled = await inner.sessions.cancel(sessionId);
              const state = states.get(sessionId);
              if (state === undefined || (state.activeMessageId === undefined && state.queued.length === 0)) {
                return innerCancelled;
              }
              const stoppedIds: string[] = [];
              const nextMessages = { ...state.messages };

              if (state.activeMessageId !== undefined) {
                const active = nextMessages[state.activeMessageId];
                if (active !== undefined && !hasEnded(active)) {
                  stoppedIds.push(active.id);
                  const pendingItems = active.items.filter((i) => i.state.status === "pending");
                  const canceledItems = active.items.map((item) =>
                    item.state.status === "pending" ? { ...item, state: { status: "canceled" as const } } : item,
                  );
                  const canceledMsg: StoredInterruptMessage = {
                    ...active,
                    phase: "settled",
                    status: "canceled",
                    items: canceledItems,
                    updatedAt: Date.now(),
                  };
                  nextMessages[active.id] = canceledMsg;
                  for (const p of pendingItems) {
                    emitExtra(sessionId, {
                      type: "interrupt_resolved",
                      interruptId: p.interrupt.id,
                      messageId: active.id,
                      resolution: "canceled",
                    });
                  }
                  const pub = toPublicInterruptMessage(canceledMsg);
                  emitExtra(sessionId, { type: "done", message: pub });
                  notifyWaiters(pub);
                }
              }

              for (const q of state.queued) {
                stoppedIds.push(q.id);
                const existingQ = nextMessages[q.id];
                const canceledQ: StoredInterruptMessage = {
                  id: q.id,
                  sessionId: SessionId.make(sessionId),
                  ...(q.request.idempotencyKey === undefined
                    ? {}
                    : { idempotencyKey: IdempotencyKey.make(q.request.idempotencyKey) }),
                  ...(q.request.metadata === undefined ? {} : { metadata: q.request.metadata }),
                  phase: "settled",
                  status: "canceled",
                  items: [],
                  createdAt: existingQ?.createdAt ?? q.createdAt,
                  updatedAt: Date.now(),
                };
                nextMessages[q.id] = canceledQ;
                const pubQ = toPublicInterruptMessage(canceledQ);
                emitExtra(sessionId, { type: "done", message: pubQ });
                notifyWaiters(pubQ);
              }

              const { activeMessageId: _dropped, ...withoutActive } = state;
              const nextState: SessionInterruptState = { ...withoutActive, messages: nextMessages, queued: [] };
              const rawSnap = await inner.sessions.get(sessionId);
              await saveState(nextState);
              emitExtra(sessionId, { type: "state", session: overlaySession(rawSnap, nextState) });

              return { stopped: [...new Set([...stoppedIds, ...innerCancelled.stopped])] };
            });
          },
        },
        messages: {
          async send(rawRequest, sendOptions) {
            const decoded = decodeRequest(SendRequest, rawRequest, "messages.send");
            if (sendOptions?.wait !== undefined) decodeRequest(Wait, sendOptions.wait, "wait");
            if (sendOptions?.signal?.aborted) throw sendOptions.signal.reason;
            const { message } = await withSessionLock(decoded.sessionId, () => dispatchAdmittedSendLocked(rawRequest));
            if (sendOptions?.wait === undefined) return message;
            try {
              return await waitForOuterMessage({ sessionId: message.sessionId, messageId: message.id }, sendOptions);
            } catch (error) {
              if (sendOptions.signal?.aborted) throw sendOptions.signal.reason;
              if ((error as { code?: unknown } | null)?.code === "unconfirmed") throw error;
              const msg = error instanceof Error ? error.message : String(error);
              throw agentError("unconfirmed", `The message was recorded, and waiting for it failed: ${msg}`, {
                sessionId: message.sessionId,
                messageId: message.id,
                ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
              });
            }
          },
          stream(rawRequest, streamOptions) {
            let decoded: ReturnType<typeof decodeRequest<typeof SendRequest>>;
            try {
              decoded = decodeRequest(SendRequest, rawRequest, "messages.stream");
            } catch (error) {
              return {
                [Symbol.asyncIterator]: () => ({
                  next: () => Promise.reject(error),
                  return: async () => ({ done: true as const, value: undefined }),
                }),
              };
            }
            return messageStream(
              {
                events: (sid, after) => sessionEvents(sid, after === undefined ? {} : { after }),
                admit: (req) => withSessionLock(decoded.sessionId, () => dispatchAdmittedSendLocked(req)),
                get: (sid, mid) => getOuterMessage(SessionId.make(sid), MessageId.make(mid)),
                entry: async (sid, eid) => {
                  let cursor: string | undefined;
                  for (;;) {
                    const page = await readProjectedEntries(sid, {
                      ...(cursor === undefined ? {} : { before: cursor }),
                      limit: 500,
                    });
                    const found = page.data.find((e) => e.id === eid);
                    if (found !== undefined) return found;
                    if (page.prev === undefined) break;
                    cursor = page.prev;
                  }
                  throw agentError("not_found", `Entry ${eid} not found in session ${sid}`);
                },
                entries: (sid, opts) => readProjectedEntries(sid, opts),
              },
              rawRequest,
              streamOptions?.signal,
            );
          },
          async get(rawKey, getOptions) {
            const key = decodeRequest(MessageKey, rawKey, "messages.get");
            await inner.sessions.get(key.sessionId);
            return waitForOuterMessage(key, getOptions);
          },
          async resolve(rawRequest, resolveOptions) {
            const decoded = decodeRequest(ResolveInterruptRequest, rawRequest, "messages.resolve");
            const { sessionId, interruptId, resolution, idempotencyKey } = decoded;
            await inner.sessions.get(sessionId);

            const decision = await withSessionLock(sessionId, async () => {
              const state = states.get(sessionId);
              if (state === undefined) {
                throw agentError("not_found", `Interrupt ${interruptId} not found in session ${sessionId}`);
              }

              const prevResolved = state.resolvedKeys[interruptId];
              if (prevResolved !== undefined) {
                if (idempotencyKey !== undefined && prevResolved.key === idempotencyKey) {
                  return { shouldExecuteRound: false, messageId: prevResolved.messageId };
                }
                throw agentError("conflict", `Interrupt ${interruptId} has already been resolved`);
              }

              const activeId = state.activeMessageId;
              const activeMsg = activeId === undefined ? undefined : state.messages[activeId];
              const itemIndex = activeMsg?.items.findIndex((item) => item.interrupt.id === interruptId) ?? -1;

              if (activeMsg === undefined || itemIndex === -1) {
                const historical = Object.values(state.messages).find((m) =>
                  m.items.some((i) => i.interrupt.id === interruptId),
                );
                if (historical !== undefined) {
                  throw agentError("conflict", `Interrupt ${interruptId} is no longer pending (${historical.status})`);
                }
                throw agentError("not_found", `Interrupt ${interruptId} not found in session ${sessionId}`);
              }

              const targetItem = activeMsg.items[itemIndex] as StoredInterruptItem;
              if (targetItem.state.status !== "pending") {
                if (
                  idempotencyKey !== undefined &&
                  "key" in targetItem.state &&
                  targetItem.state.key === idempotencyKey
                ) {
                  return { shouldExecuteRound: false, messageId: activeMsg.id };
                }
                throw agentError("conflict", `Interrupt ${interruptId} is already ${targetItem.state.status}`);
              }

              validateResolutionPayload(targetItem, resolution);

              const nextItemState: StoredInterruptItem["state"] =
                resolution.action === "approve"
                  ? { status: "approved", ...(idempotencyKey === undefined ? {} : { key: idempotencyKey }) }
                  : resolution.action === "deny"
                    ? {
                        status: "denied",
                        ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
                        ...(idempotencyKey === undefined ? {} : { key: idempotencyKey }),
                      }
                    : {
                        status: "submitted",
                        input: resolution.input,
                        ...(idempotencyKey === undefined ? {} : { key: idempotencyKey }),
                      };

              const nextItems = activeMsg.items.with(itemIndex, { ...targetItem, state: nextItemState });
              const allResolved = nextItems.every((i) => i.state.status !== "pending");
              const nextMsg: StoredInterruptMessage = {
                ...activeMsg,
                phase: allResolved ? "resuming" : "parked",
                status: allResolved ? "running" : parkedStatusOf(nextItems),
                items: nextItems,
                updatedAt: Date.now(),
              };
              const nextResolvedKeys =
                idempotencyKey === undefined
                  ? state.resolvedKeys
                  : { ...state.resolvedKeys, [interruptId]: { key: idempotencyKey, messageId: activeMsg.id } };
              const nextState: SessionInterruptState = {
                ...state,
                messages: { ...state.messages, [activeMsg.id]: nextMsg },
                resolvedKeys: nextResolvedKeys,
              };
              const rawSnap = await inner.sessions.get(sessionId);
              await saveState(nextState);

              const eventResolution =
                resolution.action === "approve" ? "approved" : resolution.action === "deny" ? "denied" : "submitted";
              emitExtra(sessionId, {
                type: "interrupt_resolved",
                interruptId,
                messageId: activeMsg.id,
                resolution: eventResolution,
              });
              emitExtra(sessionId, { type: "state", session: overlaySession(rawSnap, nextState) });

              return { shouldExecuteRound: allResolved, messageId: activeMsg.id };
            });

            if (decision.shouldExecuteRound) {
              void executeResolvedRound(sessionId, decision.messageId);
            }

            if (resolveOptions?.wait === undefined) {
              return getOuterMessage(sessionId, decision.messageId);
            }
            return waitForOuterMessage({ sessionId, messageId: decision.messageId }, resolveOptions);
          },
        },
      };

      return decorated;
    },
  };
}
