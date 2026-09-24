/**
 * Test faux model wiring for pi 0.80's `Models` collections.
 *
 * pi 0.80 removed the global `registerFauxProvider()` registry; faux providers
 * now live in explicit `Models` collections. This helper restores the old
 * one-call ergonomics: build a `Models` with a single faux provider registered,
 * and return both so tests can pass `models` + `faux.getModel()` to a harness.
 */
import {
  type Models,
  type RegisterFauxProviderOptions,
  type TranscriptContext,
  createModels,
  fauxProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";

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

/**
 * What a fastagent turn touches on a pi `AgentSession` beyond prompt/subscribe/dispose, for a hand-written double:
 * a session with no extensions loaded that is idle once `prompt()` returns.
 */
export const bareSessionParts = {
  waitForIdle: async () => {},
  extensionRunner: {
    onError: () => () => {},
    emit: async () => undefined,
    hasHandlers: () => false,
    getRegisteredCommands: () => [],
  },
};
