/**
 * Test faux model wiring for pi 0.80's `Models` collections.
 *
 * pi 0.80 removed the global `registerFauxProvider()` registry; faux providers
 * now live in explicit `Models` collections. This helper restores the old
 * one-call ergonomics: build a `Models` with a single faux provider registered,
 * and return both so tests can pass `models` + `faux.getModel()` to a harness.
 */
import { type Models, type RegisterFauxProviderOptions, createModels, fauxProvider } from "@earendil-works/pi-ai";

export function makeFaux(options?: RegisterFauxProviderOptions): {
  faux: ReturnType<typeof fauxProvider>;
  models: Models;
} {
  const faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}
