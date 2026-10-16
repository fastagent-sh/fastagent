/**
 * Test faux model wiring for pi 0.80's `Models` collections.
 *
 * pi 0.80 removed the global `registerFauxProvider()` registry; faux providers
 * now live in explicit `Models` collections. This helper restores the old
 * one-call ergonomics: build a `Models` with a single faux provider registered,
 * and return both so tests can pass `models` + `faux.getModel()` to a harness.
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
import { createPiAgent } from "../src/harnesses/pi/create.ts";
import type { Agent } from "../src/protocol.ts";

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

/** A SPEC v1 agent on pi (`createPiAgent`) answering from `responses`, in memory: the real harness, no network. */
export function fauxPiAgent(responses: FauxResponseStep[]): Agent {
  const { faux } = makeFaux();
  faux.setResponses(responses);
  const model = faux.getModel();
  return createPiAgent({ model: `${model.provider}/${model.id}`, providers: [faux.provider], instructions: "test" });
}
