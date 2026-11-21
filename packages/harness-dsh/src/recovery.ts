/**
 * Cold-boot session/message restoration and SIGKILL crash recovery for `@fastagent-sh/harness-dsh`.
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { ensureDshAgent } from "./event-bridge.ts";
import { type DshRuntimeState, createLiveSession } from "./session-state.ts";
import type { DshStoredMessage } from "./types.ts";
import { toDshBlocks } from "./validation.ts";

export async function restoreAndRecoverSessions(state: DshRuntimeState): Promise<void> {
  const { store, options, liveSessions, allMessages, messagesByKey } = state;

  const storedMetas = (await store.listSessionMetas?.()) ?? [];
  for (const meta of storedMetas) {
    if (meta.order >= state.nextSessionOrder) state.nextSessionOrder = meta.order + 1;
    if (meta.deleted) continue;
    liveSessions.set(meta.id, createLiveSession(structuredClone(meta)));
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

  for (const live of liveSessions.values()) {
    const sessionMsgs = [...(allMessages.get(live.meta.id)?.values() ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    const runningMsgs = sessionMsgs.filter((m) => m.status === "running");
    const queuedMsgs = sessionMsgs.filter((m) => m.status === "queued");
    if (runningMsgs.length === 0 && queuedMsgs.length === 0) continue;
    if (options.unfinished === "refuse") {
      await state.ctx.fiber.dispose().catch(() => {});
      throw new Error(
        `this instance has ${runningMsgs.length + queuedMsgs.length} unfinished message(s) from a stopped serve; start the serve (\`fastagent dev\` or \`fastagent start\`) to finish them`,
      );
    }

    const dshAgent = await ensureDshAgent(state, live);
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
}
