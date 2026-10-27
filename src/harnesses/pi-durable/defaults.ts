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

/** Why a session's settings cannot answer a message: a model the agent lacks, or tools it no longer has. */
export type Unanswerable = { missing: "model"; model: ModelRef | undefined } | { missing: "tools"; tools: string[] };

/**
 * Take the defaults the conversation's settings lack, unless the settings cannot answer a message: the model it would
 * answer with is not among the agent's models, or a tool it enables is not among the agent's tools. Then nothing is
 * written, and what is missing is returned so the message can be refused.
 */
export async function admitSettings(
  tx: Tx,
  conversationId: ConversationId,
  defaults: Defaults,
  has: { model(model: ModelRef): boolean; tool(name: string): boolean },
): Promise<Unanswerable | undefined> {
  const agent = await tx.doc(AgentDoc, conversationId);
  const model = agent.model ?? defaults.model;
  if (model === undefined || !has.model(model)) {
    return {
      missing: "model",
      model: model === undefined ? undefined : { provider: model.provider, modelId: model.modelId },
    };
  }
  const missing = Array.isArray(agent.tools) ? agent.tools.filter((name) => !has.tool(name)) : [];
  if (missing.length > 0) return { missing: "tools", tools: missing };
  await configure(tx, conversationId, {
    ...(agent.model === undefined ? { model } : {}),
    ...(agent.thinkingLevel === undefined && defaults.thinkingLevel !== undefined
      ? { thinkingLevel: defaults.thinkingLevel }
      : {}),
  });
  return undefined;
}
