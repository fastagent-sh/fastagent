/**
 * The models a Sign in with ChatGPT can run on the `openai` provider: the ACCOUNT's catalog, which OpenAI publishes at
 * `GET /v1/models` for the same access token, not pi's built-in list (most of which such an account is refused).
 *
 * pi lists a provider's models through `filterModels`, which is synchronous, so the catalog is read when there is a
 * token to read it with (login and every token refresh) and kept on the credential, like the account it belongs to:
 * a new account brings its own list, and nothing per-account lands in the definition's model catalog. pi's `openai`
 * provider does not do this itself (as of pi 1.0.1), so {@link withAccountModels} wraps it. An API key on the same
 * provider keeps the built-in list.
 */
import type { Credential, OAuthAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { log } from "../../log.ts";

export const OPENAI_PROVIDER = "openai";
const ACCOUNT_MODELS_URL = "https://api.openai.com/v1/models";
/** Where the catalog is kept on the stored credential: the model ids the account lists, in OpenAI's order. */
const ACCOUNT_MODELS_FIELD = "accountModels";
/** A token refresh is bounded at 15s by pi; the catalog read must leave it room to finish and be stored. */
const CATALOG_TIMEOUT_MS = 5_000;

/** The slugs the account lists for a picker (`visibility: "list"`), in the server's order. */
async function fetchAccountModels(access: string, signal?: AbortSignal): Promise<string[]> {
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  const response = await fetch(ACCOUNT_MODELS_URL, {
    headers: { accept: "application/json", authorization: `Bearer ${access}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GET ${ACCOUNT_MODELS_URL} answered ${response.status}: ${body || response.statusText}`);
  }
  const models = ((await response.json()) as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new Error(`GET ${ACCOUNT_MODELS_URL} answered without a "models" array`);
  return models.flatMap((entry: { slug?: unknown; visibility?: unknown } | null) =>
    entry?.visibility === "list" && typeof entry.slug === "string" ? [entry.slug] : [],
  );
}

/** The catalog a ChatGPT sign-in carries, or undefined when it carries none (signed in before it was read). */
function accountModels(credential: OAuthCredential): readonly string[] | undefined {
  const ids = credential[ACCOUNT_MODELS_FIELD];
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : undefined;
}

/**
 * Why the stored `openai` credential lists no models, when that is because its sign-in carries no catalog: the one wording a
 * listing reports instead of falling back to every built-in model.
 */
export function missingAccountModels(credential: Credential | undefined): string | undefined {
  if (credential?.type !== "oauth" || accountModels(credential)) return undefined;
  return (
    "[fastagent] the ChatGPT sign-in for openai carries no model catalog, so it lists no models: it is read at " +
    "login and on each token refresh. Run `fastagent login` to read it now"
  );
}

/**
 * `provider` with the account catalog: read at login and at each token refresh, and the only models a ChatGPT
 * sign-in lists. Anything without OAuth is returned as is.
 */
export function withAccountModels(provider: Provider): Provider {
  const oauth = provider.auth.oauth;
  if (!oauth) return provider;
  const wrapped: OAuthAuth = {
    ...oauth,
    async login(interaction, options) {
      const credential = await oauth.login(interaction, options);
      try {
        return {
          ...credential,
          [ACCOUNT_MODELS_FIELD]: await fetchAccountModels(credential.access, interaction.signal),
        };
      } catch (error) {
        // The sign-in itself worked and inference needs nothing more: keep it, and say the list is empty until the
        // next token refresh reads the catalog.
        interaction.notify({
          type: "info",
          message: `could not read this ChatGPT account's model catalog (${(error as Error).message}); it lists no models until the next token refresh or login`,
        });
        return credential;
      }
    },
    async refresh(credential, signal) {
      const next = await oauth.refresh(credential, signal);
      try {
        return { ...next, [ACCOUNT_MODELS_FIELD]: await fetchAccountModels(next.access, signal) };
      } catch (error) {
        // NEVER fail here: the refresh token was just rotated, and a throw would leave the new one unstored and the
        // old one spent. The previous catalog stands.
        log.warn(`[fastagent] could not refresh the ChatGPT account's model catalog: ${(error as Error).message}`);
        const previous = accountModels(credential);
        return previous ? { ...next, [ACCOUNT_MODELS_FIELD]: previous } : next;
      }
    },
  };
  return {
    ...provider,
    auth: { ...provider.auth, oauth: wrapped },
    filterModels: (models, credential) => {
      const base = provider.filterModels?.(models, credential) ?? models;
      if (credential?.type !== "oauth") return base;
      const listed = new Set(accountModels(credential) ?? []);
      return base.filter((model) => listed.has(model.id));
    },
  };
}

/**
 * Put {@link withAccountModels} on a runtime's `openai`, over the provider the runtime composed (pi's remote catalog
 * and the agent's models.json included), so neither is lost. pi composes a native provider with models.json once more;
 * that second pass is idempotent today, and openai-account-models.test.ts holds it to that. Call it inside
 * `withModelRegistration`.
 */
export function registerAccountModels(runtime: ModelRuntime): void {
  const provider = runtime.getProvider(OPENAI_PROVIDER);
  if (provider) runtime.registerNativeProvider(withAccountModels(provider));
}
