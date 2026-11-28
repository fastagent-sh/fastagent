/**
 * Per-session serialized message admission, idempotency replay, attachment persistence,
 * busy/steer/queue dispatch, and settlement waiting for `@fastagent-sh/harness-dsh`.
 */
import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  type ContentPart,
  type Message,
  MessageId,
  SendRequest,
  agentError,
  decodeRequest,
  hasEnded,
} from "@fastagent-sh/client/agent-api";
import { applyScopedSettings, ensureDshAgent } from "./event-bridge.ts";
import { toPublicMessage } from "./projection.ts";
import {
  type DshRuntimeState,
  type LiveSession,
  type Waiter,
  getStoredMessage,
  persistMessage,
  persistSessionMeta,
  requireSession,
} from "./session-state.ts";
import type { AgentCommand } from "@fastagent-sh/fastagent/harness";
import type { DshStoredMessage } from "./types.ts";
import { normalizeSendContent, toDshBlocks } from "./validation.ts";

export async function waitForMessage(
  state: DshRuntimeState,
  live: LiveSession,
  messageId: string,
  waitSeconds: number | undefined,
  signal: AbortSignal | undefined,
): Promise<Message> {
  const current = getStoredMessage(state, live.meta.id, messageId);
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
        const latest = getStoredMessage(state, live.meta.id, messageId);
        resolve(toPublicMessage(latest ?? current));
      }, waitSeconds * 1000);
    }
    waiterSet.add(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function admitMessage(
  state: DshRuntimeState,
  rawRequest: SendRequest,
  commands: readonly AgentCommand[],
): Promise<{ message: Message; replayed: boolean }> {
  const request = decodeRequest(SendRequest, rawRequest, "messages.send");
  const live = requireSession(state, request.sessionId);

  const idempotencyKey = request.idempotencyKey;
  const metadata = request.metadata;
  const whenBusy = request.whenBusy ?? "queue";
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
      const existingId = state.messagesByKey.get(live.meta.id)?.get(idempotencyKey);
      if (existingId !== undefined) {
        const existing = getStoredMessage(state, live.meta.id, existingId);
        if (existing !== undefined) {
          return { message: toPublicMessage(existing), replayed: true };
        }
      }
    }

    const effectiveModel = live.meta.model ?? state.options.model;
    if (effectiveModel === undefined) {
      throw agentError(
        "missing_model",
        state.options.unusableDefault === undefined
          ? "no model configured for session or agent"
          : `This session names no model, and the agent's default ${state.options.unusableDefault.spec} is unusable: ${state.options.unusableDefault.reason}`,
      );
    }
    if (
      state.options.models !== undefined &&
      state.options.models.getModel(effectiveModel.provider, effectiveModel.modelId) === undefined
    ) {
      throw agentError(
        "missing_model",
        `model "${effectiveModel.provider}/${effectiveModel.modelId}" is not available`,
        { model: `${effectiveModel.provider}/${effectiveModel.modelId}` },
      );
    }

    if (live.meta.tools !== undefined) {
      const missing = live.meta.tools.filter((name) => !state.toolsByName.has(name));
      if (missing.length > 0) {
        throw agentError("missing_tool", `session references unavailable tools: ${missing.join(", ")}`, {
          tools: missing,
        });
      }
    }

    live.storageErrored = false;
    const dshAgent = await ensureDshAgent(state, live);
    const busy = dshAgent.status === "running" || live.activeTurnMessageIds.length > 0;
    if (busy && whenBusy === "reject") {
      throw agentError("busy", "session is currently running another message", { reason: "running" });
    }

    if (live.meta.model === undefined) {
      live.meta = { ...live.meta, model: effectiveModel, updatedAt: Date.now() };
      await persistSessionMeta(state, live.meta);
      applyScopedSettings(state, live);
    }

    const displayContent: ContentPart[] = [];
    const modelContent: ContentPart[] = [];
    for (let i = 0; i < rawParts.length; i++) {
      const raw = rawParts[i] as ContentPart;
      const expanded = expandedParts[i] as ContentPart;
      if (raw.type === "image" && "data" in raw) {
        const ref = randomUUID();
        const bytes = Buffer.from(raw.data, "base64");
        await state.store.putAttachment?.({
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
    await persistMessage(state, stored);

    if (busy) {
      live.queuedMessages.push({ id: MessageId.make(messageId), mode: whenBusy === "steer" ? "steer" : "queue" });
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
}
