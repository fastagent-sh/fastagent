/**
 * Bridges DSH `AgentLoop` lifecycle events, retries, scoped settings, and durability-before-`done`
 * turn settlement onto FastAgent's `SessionEvent` and message ledger.
 */
import type { Agent as DshLoopAgent, AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { type SessionEvent, hasEnded } from "@fastagent-sh/client/agent-api";
import {
  addTokens,
  classifyLlmFailure,
  isRetryableLlmFailure,
  projectSessionEvent,
  toPublicMessage,
} from "./projection.ts";
import {
  type DshRuntimeState,
  type LiveSession,
  broadcast,
  emitNow,
  failSessionWatchersAndWaiters,
  getStoredMessage,
  notifyMessageSettled,
  persistMessage,
  persistSessionMeta,
} from "./session-state.ts";
import type { DshStoredMessage } from "./types.ts";
import { makeAgentOptions } from "./validation.ts";

export function applyScopedSettings(state: DshRuntimeState, live: LiveSession): void {
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
    const allowed = live.meta.tools.filter((name) => state.toolsByName.has(name));
    if (allowed.length > 0) {
      live.toolsDisposer = dshAgent.ctx.tools.restrict({ allow: allowed });
    } else if (state.toolsByName.size > 0) {
      live.toolsDisposer = dshAgent.ctx.tools.restrict({ deny: [...state.toolsByName.keys()] });
    }
  }
  const effectiveModel = live.meta.model ?? state.options.model;
  const effectiveThinking = live.meta.thinkingLevel ?? state.options.thinkingLevel;
  if (effectiveModel !== undefined) {
    dshAgent.model.select({
      provider: effectiveModel.provider,
      model: effectiveModel.modelId,
      ...(effectiveThinking !== undefined && effectiveThinking !== "off"
        ? { reasoningEffort: effectiveThinking as ReasoningEffortId }
        : {}),
    });
  }
}

export function bindDshAgentEvents(state: DshRuntimeState, live: LiveSession, dshAgent: DshLoopAgent): void {
  const agentCtx = dshAgent.ctx;
  const fail = (error: unknown) => failSessionWatchersAndWaiters(state.liveSessions, live.meta.id, error);

  for (const event of dshAgent.session.snapshotEvents()) {
    if (event.type === "assistant/message") {
      for (const block of event.data.message.content) {
        if (block.type === "tool-call") live.toolNamesByCallId.set(block.id, block.name);
      }
    }
  }

  agentCtx.on("agent/request-error", async (payload, next) => {
    if (!isRetryableLlmFailure(payload.failure) || state.maxRetries <= 0) return next();
    const key = `${payload.turn}:${payload.step}`;
    const prev = live.retryCounts.get(key) ?? 0;
    if (prev >= state.maxRetries) return next();
    const attempt = prev + 1;
    live.retryCounts.set(key, attempt);
    const delayMs = state.baseDelayMs * attempt;
    broadcast(live, {
      type: "retrying",
      attempt,
      maxAttempts: state.maxRetries,
      delayMs,
      reason: payload.failure.message,
    });
    await new Promise<void>((resolve) => {
      if (payload.signal.aborted) return resolve();
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        payload.signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      payload.signal.addEventListener("abort", onAbort, { once: true });
    });
    if (payload.signal.aborted) return next();
    return { kind: "retry" as const };
  });

  agentCtx.on("agent/status", ({ status }: { status: "idle" | "running" }) => {
    if (status !== "idle" || state.closing || live.storageErrored || live.meta.deleted) return;
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
        const existing = getStoredMessage(state, live.meta.id, msgId);
        if (existing !== undefined && !hasEnded(existing)) {
          const updated: DshStoredMessage = {
            ...existing,
            status: "running",
            entryId: projected.entry.id,
            updatedAt: Date.now(),
          };
          void persistMessage(state, updated).catch(fail);
        }
      }

      if (event.type === "assistant/message") {
        if (projected.modelKey !== undefined && projected.tokens !== undefined) {
          addTokens(live.meta.usage.models, projected.modelKey, projected.tokens);
          live.meta = { ...live.meta, updatedAt: Date.now() };
          void persistSessionMeta(state, live.meta).catch(fail);
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
        const stored = getStoredMessage(state, live.meta.id, msgId);
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
          await state.ctx.sessions.flush(dshAgent.session);
          for (const next of settled) {
            if (state.store.putMessage !== undefined) await state.store.putMessage(next);
          }
          live.meta = { ...live.meta, updatedAt: Date.now() };
          await persistSessionMeta(state, live.meta);
          live.storageErrored = false;
          for (const next of settled) {
            let bySession = state.allMessages.get(next.sessionId);
            if (bySession === undefined) {
              bySession = new Map();
              state.allMessages.set(next.sessionId, bySession);
            }
            bySession.set(next.id, next);
            const pub = toPublicMessage(next);
            emitNow(live, { type: "done", message: pub });
            notifyMessageSettled(live, pub);
          }
        })
        .catch(fail)
        .finally(() => {
          if (live.pendingSettlement === settleTask) {
            live.pendingSettlement = undefined;
            const buffered = live.bufferedEvents.splice(0);
            if (!live.storageErrored) {
              for (const ev of buffered) emitNow(live, ev);
            }
          }
        });
      live.pendingSettlement = settleTask;
    }
  });
}

export async function ensureDshAgent(state: DshRuntimeState, live: LiveSession): Promise<DshLoopAgent> {
  if (live.dshAgent !== undefined) return live.dshAgent;
  const effectiveModel = live.meta.model ?? state.options.model;
  const effectiveThinking = live.meta.thinkingLevel ?? state.options.thinkingLevel;
  const handle = await state.ctx.agents.resume({
    resumeSessionId: SessionId(live.meta.id),
    agentOptions: makeAgentOptions(effectiveModel, effectiveThinking),
  });
  live.dshHandle = handle;
  live.dshAgent = handle.agent;
  bindDshAgentEvents(state, live, handle.agent);
  applyScopedSettings(state, live);
  return handle.agent;
}
