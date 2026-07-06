/**
 * The pi `Models` collection — the single hub that owns BOTH model resolution (provider/modelId
 * lookup) AND auth (per-request credential resolution). fastagent builds one per opener and threads
 * it into the harness alongside the selected `model`; the two must come from the same collection so
 * the model's provider auth is in scope.
 */
import { type Models, type Provider, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { log } from "../../log.ts";
import { type FastagentAuthOptions, fastagentCredentialStore } from "./auth.ts";

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

/**
 * The "provider/modelId" specs whose provider currently has USABLE credentials (a stored login or an
 * env key) — the menu for the first-run model picker (`fastagent dev`/`start`/`invoke` with no model
 * set). Auth is provider-scoped, so probe once per provider (any of its models) rather than per model.
 * A provider that resolves no auth (unconfigured) or rejects it (configured-but-expired) is omitted:
 * the picker offers only models that would actually run now; `fastagent login` fixes the rest. Sorted.
 *
 * pi deliberately has no "best/tier" ranking on Model, so this does not auto-pick — it narrows the menu
 * to what the user can use and lets them choose (mirroring pi-coding-agent's select-then-persist).
 */
export async function configuredModelSpecs(models: Models): Promise<string[]> {
  const specs: string[] = [];
  for (const provider of models.getProviders()) {
    const [probe] = provider.getModels();
    if (!probe) continue;
    let usable: boolean;
    try {
      usable = (await models.getAuth(probe)) !== undefined;
    } catch (error) {
      // Configured-but-broken (expired token, a refresh network failure, a corrupt store): omit it
      // from the menu, but SAY so — a silent disappearance is the same fail-visibly gap the caller
      // guards against for the top-level enumeration. `undefined` (plainly unconfigured) stays quiet.
      log.warn(`[fastagent] skipping provider "${provider.id}": auth check failed (${(error as Error).message})`);
      continue;
    }
    if (!usable) continue;
    for (const model of provider.getModels()) specs.push(`${provider.id}/${model.id}`);
  }
  return specs.sort();
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
