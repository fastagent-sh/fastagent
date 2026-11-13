/**
 * Test faux model wiring: a `Models` with one faux provider registered, and an Agent answering from it.
 */
import {
  type Models,
  type RegisterFauxProviderOptions,
  type TranscriptContext,
  createModels,
  fauxProvider,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";

/** The system prompt the model was actually sent: it lives in the transcript's `messages`. */
export const sentPrompt = (context: TranscriptContext): string => getCurrentSystemPrompt(context.messages);

export function makeFaux(options?: RegisterFauxProviderOptions): {
  faux: ReturnType<typeof fauxProvider>;
  models: Models;
} {
  const faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}
