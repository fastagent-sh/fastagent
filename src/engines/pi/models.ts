/**
 * The pi `Models` collection — the single hub that owns BOTH model resolution (provider/modelId
 * lookup) AND auth (per-request credential resolution). fastagent builds one per opener and threads
 * it into the harness alongside the selected `model`; the two must come from the same collection so
 * the model's provider auth is in scope.
 */
import { type Models, type Provider, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type FastagentAuthOptions, fastagentCredentialStore } from "./auth.ts";
import { hasInteractiveLogin } from "./login.ts";

export interface CreatePiModelsOptions extends FastagentAuthOptions {
  /** Credentials file path. Defaults to the global `~/.fastagent/auth.json`; the directory opener passes
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

/** Per-provider auth status for the first-run model picker: usable now (with the source label), not
 *  configured, or configured-but-broken (expired token, refresh failure, corrupt store — kept as DATA
 *  so the picker can show it instead of silently dropping the provider). Non-ready states carry
 *  whether `loginFlow` can actually fix them ({@link hasInteractiveLogin}), so the picker's hint
 *  never promises a login that doesn't exist (env-key-only providers). */
export type ProviderAuthStatus =
  | { state: "ready"; source?: string }
  | { state: "unconfigured"; interactiveLogin: boolean }
  | { state: "broken"; message: string; interactiveLogin: boolean };

/**
 * Probe every provider's auth once (auth is provider-scoped, so any of its models works as the probe)
 * — the status map behind the first-run model picker (`fastagent dev`/`start`/`invoke` with no model
 * set). The picker shows the FULL catalog annotated with these statuses, so "what fastagent supports"
 * and "what is authenticated on this machine" stay distinguishable; a needs-login choice triggers an
 * inline `loginFlow`. Providers with no models are omitted (nothing to pick).
 */
export async function providerAuthStatuses(models: Models): Promise<Map<string, ProviderAuthStatus>> {
  const statuses = new Map<string, ProviderAuthStatus>();
  for (const provider of models.getProviders()) {
    const [probe] = provider.getModels();
    if (!probe) continue;
    const interactiveLogin = hasInteractiveLogin(provider);
    try {
      const auth = await models.getAuth(probe);
      statuses.set(
        provider.id,
        auth ? { state: "ready", source: auth.source } : { state: "unconfigured", interactiveLogin },
      );
    } catch (error) {
      statuses.set(provider.id, { state: "broken", message: (error as Error).message, interactiveLogin });
    }
  }
  return statuses;
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
