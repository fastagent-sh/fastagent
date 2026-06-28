/**
 * The pi `Models` collection — the single hub that owns BOTH model resolution (provider/modelId
 * lookup) AND auth (per-request credential resolution). fastagent builds one per opener and threads
 * it into the harness alongside the selected `model`; the two must come from the same collection so
 * the model's provider auth is in scope.
 */
import { type Models, type Provider, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type FastagentAuthOptions, fastagentCredentialStore } from "./auth.ts";

export interface CreatePiModelsOptions extends FastagentAuthOptions {
  /** Override the credentials file path (default `~/.fastagent/auth.json`). */
  authPath?: string;
  /** Extra providers registered on top of the built-ins (same id overrides a built-in). */
  providers?: Provider[];
}

/**
 * A `Models` with every built-in pi provider, wired to fastagent's auth: stored credentials from
 * `~/.fastagent/auth.json` (via {@link fastagentCredentialStore}), then ambient env vars. A stored
 * credential owns the provider; env is consulted only when nothing is stored (resolution order is upstream-owned).
 */
export function createPiModels(options: CreatePiModelsOptions = {}): Models {
  const models = builtinModels({
    credentials: fastagentCredentialStore(options.authPath, { warn: options.warn }),
    authContext: defaultProviderAuthContext(),
  });
  for (const provider of options.providers ?? []) models.setProvider(provider);
  return models;
}

/**
 * Which source currently satisfies auth for `spec` — a startup diagnostic. Returns the upstream
 * `AuthResult.source` label (e.g. "OAuth", "ANTHROPIC_API_KEY") or undefined when unconfigured.
 * Reporting-only; never throws.
 */
export async function probeAuthSource(models: Models, spec: string): Promise<string | undefined> {
  const slash = spec.indexOf("/");
  if (slash < 1) return undefined;
  const model = models.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) return undefined;
  const auth = await models.getAuth(model).catch(() => undefined);
  return auth?.source;
}
