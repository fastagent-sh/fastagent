/**
 * Which model and thinking level a conversation answers with, by precedence: its own, set through pi-durable's API,
 * over the deployment's default, which is the definition's unless a flag or the environment overrides it
 * (architecture.md §3). pi-durable reads them only from the conversation's `pi.agent`, so FastAgent writes the default
 * there and remembers what it wrote: a value it did not write is the conversation's own and is kept. A conversation
 * that sets the very value the default had cannot be told from one following it, and follows the next default.
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  type ConversationId,
  type ModelRef,
  type Tx,
  configure,
  defineDoc,
} from "@earendil-works/pi-durable";

export interface Defaults {
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
}

/** What FastAgent last wrote into `pi.agent`; rewindable like it, so a fork starts with both as of its entry. */
const WrittenDoc = defineDoc<{ model?: ModelRef; thinkingLevel?: ModelThinkingLevel }>({
  kind: "fastagent.defaults",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
  checkpointWhen: () => true,
});

/** Bring the conversation's settings to the deployment's defaults, except those it set itself. */
export async function followDefaults(tx: Tx, conversationId: ConversationId, defaults: Defaults): Promise<void> {
  const agent = await tx.doc(AgentDoc, conversationId);
  const written = await tx.doc(WrittenDoc, conversationId);
  if (follows(agent.model, written.model, sameModel) && !sameModel(agent.model, defaults.model)) {
    await configure(tx, conversationId, { model: defaults.model ?? null });
    if (defaults.model === undefined) delete written.model;
    else written.model = { provider: defaults.model.provider, modelId: defaults.model.modelId };
  }
  if (
    follows(agent.thinkingLevel, written.thinkingLevel, Object.is) &&
    agent.thinkingLevel !== defaults.thinkingLevel
  ) {
    await configure(tx, conversationId, { thinkingLevel: defaults.thinkingLevel ?? null });
    if (defaults.thinkingLevel === undefined) delete written.thinkingLevel;
    else written.thinkingLevel = defaults.thinkingLevel;
  }
}

/** Whether a stored setting is the default FastAgent wrote, or none: whether it follows the deployment's default. */
function follows<T>(stored: T | undefined, wrote: T | undefined, same: (a: T, b: T) => boolean): boolean {
  return stored === undefined || (wrote !== undefined && same(stored, wrote));
}

function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.provider === b.provider && a.modelId === b.modelId;
}
