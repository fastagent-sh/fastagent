/**
 * Test faux model wiring: a `Models` with one faux provider registered, and an Agent answering from it.
 */
import {
  type FauxResponseStep,
  type Models,
  type RegisterFauxProviderOptions,
  type TranscriptContext,
  createModels,
  fauxProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { type DurableAgent, openDurableAgent } from "../src/harnesses/pi-durable/agent.ts";

/**
 * What the model was actually sent. pi 0.86 normalized provider stream input to `TranscriptContext`:
 * the system prompt and tool set live in `messages`, replayed through these two readers.
 */
export const sentPrompt = (context: TranscriptContext): string => getCurrentSystemPrompt(context.messages);
export const sentTools = (context: TranscriptContext): string[] => getCurrentTools(context.messages).map((t) => t.name);

export function makeFaux(options?: RegisterFauxProviderOptions): {
  faux: ReturnType<typeof fauxProvider>;
  models: Models;
} {
  const faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

/** An Agent on pi-durable answering from `responses`, in memory: the real harness, no network. */
export function fauxDurableAgent(responses: FauxResponseStep[]): Promise<DurableAgent> {
  const { faux, models } = makeFaux();
  faux.setResponses(responses);
  const model = faux.getModel();
  return openDurableAgent({
    storage: new MemoryStorage(),
    models,
    registry: createRegistry(),
    name: "faux",
    model: { provider: model.provider, modelId: model.id },
  });
}
