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

/**
 * Take the defaults the conversation's settings lack, unless the model it would answer with is not among the agent's
 * models: then nothing is written, and that model (or none) is returned so the message can be refused.
 */
export async function takeDefaults(
  tx: Tx,
  conversationId: ConversationId,
  defaults: Defaults,
  available: (model: ModelRef) => boolean,
): Promise<{ ok: true } | { ok: false; model: ModelRef | undefined }> {
  const agent = await tx.doc(AgentDoc, conversationId);
  const model = agent.model ?? defaults.model;
  if (model === undefined || !available(model)) {
    return { ok: false, model: model === undefined ? undefined : { provider: model.provider, modelId: model.modelId } };
  }
  await configure(tx, conversationId, {
    ...(agent.model === undefined ? { model } : {}),
    ...(agent.thinkingLevel === undefined && defaults.thinkingLevel !== undefined
      ? { thinkingLevel: defaults.thinkingLevel }
      : {}),
  });
  return { ok: true };
}
