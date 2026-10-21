/**
 * The deployment's default model and thinking level, for a conversation whose own settings name none. pi-durable reads
 * them only from the conversation's `pi.agent`, so the default is written there when a message is admitted; from then
 * on they are the conversation's own, as one set through pi-durable's API is (architecture.md §6.1).
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, type ModelRef, type Tx, configure } from "@earendil-works/pi-durable";

export interface Defaults {
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
}

export async function takeDefaults(tx: Tx, conversationId: ConversationId, defaults: Defaults): Promise<void> {
  const agent = await tx.doc(AgentDoc, conversationId);
  await configure(tx, conversationId, {
    ...(agent.model === undefined && defaults.model !== undefined ? { model: defaults.model } : {}),
    ...(agent.thinkingLevel === undefined && defaults.thinkingLevel !== undefined
      ? { thinkingLevel: defaults.thinkingLevel }
      : {}),
  });
}
