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
  /** Credentials file path. Defaults to the global `~/.fastagent/auth.json`; the folder opener passes
   *  the project-level `<dir>/.fastagent/auth.json`. */
  authPath?: string;
  /** Extra providers registered on top of the built-ins (same id overrides a built-in). */
  providers?: Provider[];
}

/**
 * A `Models` with every built-in pi provider, wired to fastagent's auth: stored credentials from the
 * {@link CreatePiModelsOptions.authPath} file (via {@link fastagentCredentialStore}; the global
 * `~/.fastagent/auth.json` unless the opener passes a project-level path), then ambient env vars. A
 * stored credential owns the provider; env is consulted only when nothing is stored (resolution order
 * is upstream-owned).
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
 * `AuthResult.source` label: `"OAuth"` for a stored OAuth credential (e.g. a logged-in openai-codex),
 * `"stored credential"` for a stored API key, an env-var name like `"ANTHROPIC_API_KEY"` for env, or
 * undefined when unconfigured. Reporting-only; never throws.
 */
export async function probeAuthSource(models: Models, spec: string): Promise<string | undefined> {
  const slash = spec.indexOf("/");
  if (slash < 1) return undefined;
  const model = models.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) return undefined;
  const auth = await models.getAuth(model).catch(() => undefined);
  return auth?.source;
}
