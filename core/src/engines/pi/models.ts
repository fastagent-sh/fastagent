/**
 * The pi `Models` collection — the single hub that owns BOTH model resolution
 * (provider/modelId lookup) AND auth (per-request credential resolution).
 *
 * pi 0.80 folded the old split — a global model registry (`getModel`/`getModels`)
 * plus a harness-injected `getApiKeyAndHeaders` callback — into one `Models`
 * object built from provider factories. Providers carry their own `ProviderAuth`,
 * so auth resolves through the collection (`Models.getAuth`), not a side channel.
 *
 * fastagent builds one `Models` per opener (dev/start) and threads it into the
 * harness alongside the selected `model`; the two must come from the same
 * collection so the selected model's provider auth is in scope.
 */
import { type Models, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type PiAuthOptions, piCredentialStore } from "./auth.ts";

export interface CreatePiModelsOptions extends PiAuthOptions {
  /** Override pi's credentials file path (`~/.pi/agent/auth.json`). */
  authPath?: string;
}

/**
 * A `Models` with every built-in pi provider registered, wired to fastagent's
 * default auth:
 * - **stored credentials** from pi's `~/.pi/agent/auth.json` (OAuth coding-plan
 *   tokens or `api_key` entries) via {@link piCredentialStore}, and
 * - **ambient env vars** (e.g. `ANTHROPIC_API_KEY`) via pi's default auth context.
 *
 * Resolution order is upstream-owned: a stored credential owns the provider;
 * env is consulted only when nothing is stored. This mirrors the pre-0.80
 * default (`resolvePiAuth`: OAuth first, then env) — and additionally gains
 * upstream OAuth token refresh, which the old reader did not do.
 */
export function createPiModels(options: CreatePiModelsOptions = {}): Models {
  return builtinModels({
    credentials: piCredentialStore(options.authPath, { warn: options.warn }),
    authContext: defaultProviderAuthContext(),
  });
}

/**
 * Which source currently satisfies auth for `spec` — a startup diagnostic
 * (dev/start print it). Returns the upstream `AuthResult.source` label
 * (e.g. "OAuth", "ANTHROPIC_API_KEY") or undefined when unconfigured.
 * Reporting-only; never throws (a failed OAuth refresh reports unconfigured).
 */
export async function probeAuthSource(models: Models, spec: string): Promise<string | undefined> {
  const slash = spec.indexOf("/");
  if (slash < 1) return undefined;
  const model = models.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) return undefined;
  const auth = await models.getAuth(model).catch(() => undefined);
  return auth?.source;
}
