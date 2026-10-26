/**
 * pi-ai's model collection as FastAgent composes it: the built-in providers over a credential store, and the
 * definition's own providers; and the reads a report, a login or a picker make of it. Model selection is pi-ai's
 * alone (architecture.md §3): a custom model is a provider in code (`defineAgent({ providers })`), never a models file,
 * a catalog cache or a per-account list.
 */
import {
  type Api,
  type CredentialStore,
  InMemoryCredentialStore,
  type Model,
  type Models,
  type Provider,
  defaultProviderAuthContext,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/** The provider of a `"provider/modelId"` spec. */
export function providerOf(spec: string): string {
  const slash = spec.indexOf("/");
  return slash > 0 ? spec.slice(0, slash) : spec;
}

/** Every chat model `models` offers, as `"provider/modelId"`, sorted. */
export function listModels(models: Models): string[] {
  const specs: string[] = [];
  for (const provider of models.getProviders()) {
    for (const model of provider.getModels()) specs.push(`${provider.id}/${model.id}`);
  }
  return specs.sort();
}

/** The built-ins plus `providers` (a same id replaces a built-in), over any credential store. */
export function modelsOver(credentials: CredentialStore, providers: readonly Provider[] = []): Models {
  const models = builtinModels({ credentials, authContext: defaultProviderAuthContext() });
  for (const provider of providers) models.setProvider(provider);
  return models;
}

/**
 * Whether `env` alone satisfies a provider, by pi's own check, and with what when the provider says (its API-key
 * variable, or an ambient source such as an AWS profile); undefined when it does not. A provider in code may
 * authenticate without naming a source. Passed explicitly rather than read from `process.env`: only the environment a
 * SHELL hands down is shared by every agent on the machine, and a process that has loaded an agent's `.secrets/.env`
 * holds that agent's variables too. What the shell shares outranks the global credentials file (environment.ts), so a
 * global login for such a provider is not used.
 *
 * `fileExists` answers for the files a source points at (an AWS profile, Google ADC): this machine's by default, which
 * is right wherever the answer is about THIS machine. A deployment passes one that finds nothing, because no file of
 * the builder's travels with it.
 */
export async function environmentAuth(
  providerId: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => Promise<boolean> = defaultProviderAuthContext().fileExists,
  providers: readonly Provider[] = [],
): Promise<{ source?: string } | undefined> {
  const models = builtinModels({
    credentials: new InMemoryCredentialStore(),
    authContext: {
      // pi's own reading of a variable (a blank one is unset), over the given environment.
      env: async (name) => (env[name]?.trim() ? env[name] : undefined),
      fileExists,
    },
  });
  for (const provider of providers) models.setProvider(provider);
  return models.checkAuth(providerId);
}

/**
 * What a provider can offer as an interactive login: an OAuth flow, an API-key ENTRY prompt, or nothing ("none" — the
 * key must come from the provider's env var).
 */
export type InteractiveLoginKind = "oauth" | "api_key" | "none";

export function interactiveLoginKind(p: Provider): InteractiveLoginKind {
  if (interactiveAuth(p, "oauth")) return "oauth";
  return interactiveAuth(p, "api_key") ? "api_key" : "none";
}

/** THE rule for "can this method be signed in to interactively": the auth to run for it, or undefined. */
export function interactiveAuth(provider: Provider, method: Exclude<InteractiveLoginKind, "none">) {
  return method === "oauth" ? provider.auth.oauth : provider.auth.apiKey?.login ? provider.auth.apiKey : undefined;
}

/** The providers a sign-in can target: pi's built-ins plus `extra`, composed exactly as {@link modelsOver} does. */
export function loginProviders(extra?: readonly Provider[]): readonly Provider[] {
  return modelsOver(new InMemoryCredentialStore(), extra).getProviders();
}

/** Per-provider auth status for the first-run model picker. */
export type ProviderAuthStatus =
  | { state: "ready"; source?: string }
  | { state: "unconfigured"; login: InteractiveLoginKind }
  | { state: "broken"; message: string; login: InteractiveLoginKind };

/** Probe every provider's auth once (auth is provider-scoped, so any of its models works as the probe). */
export async function providerAuthStatuses(models: Models): Promise<Map<string, ProviderAuthStatus>> {
  const statuses = new Map<string, ProviderAuthStatus>();
  for (const provider of models.getProviders()) {
    const [probe] = provider.getModels();
    if (!probe) continue;
    const login = interactiveLoginKind(provider);
    try {
      const auth = await models.getAuth(probe);
      statuses.set(provider.id, auth ? { state: "ready", source: auth.source } : { state: "unconfigured", login });
    } catch (error) {
      statuses.set(provider.id, { state: "broken", message: (error as Error).message, login });
    }
  }
  return statuses;
}

/** The source of a provider that authenticates without naming one: a definition's provider resolving its own key. */
export const UNNAMED_AUTH_SOURCE = "the provider's own auth";

/**
 * Which source currently satisfies auth for `spec`, or undefined when none does (or the spec is not in `models`).
 * Rejects when resolving fails — a corrupt entry, a refresh the provider refused — which is a different answer from
 * "nothing configured" and must reach whoever reports it.
 */
export async function probeAuthSource(models: Models, spec: string): Promise<string | undefined> {
  const slash = spec.indexOf("/");
  if (slash < 1) return undefined;
  const model = models.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) return undefined;
  // A virtual selection authenticates the physical model after routing, not its catalog entry.
  if (model.api === "pi-virtual") return "virtual";
  const auth = await models.getAuth(model);
  return auth === undefined ? undefined : (auth.source ?? UNNAMED_AUTH_SOURCE);
}

/**
 * Verdict of {@link probeApiKey}: `rejected` is DEFINITIVE (the provider answered HTTP 401 — the key is wrong);
 * everything else non-ok is `unknown`.
 */
export type KeyProbe = { state: "ok" } | { state: "rejected" | "unknown"; message: string };

/** Quick-fail probe for a just-stored API key. */
export async function probeApiKey(models: Models, model: Model<Api>, signal?: AbortSignal): Promise<KeyProbe> {
  let status: number | undefined;
  let reply: Awaited<ReturnType<Models["complete"]>>;
  try {
    reply = await models.complete(
      model,
      { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
      {
        maxTokens: 16,
        timeoutMs: 15_000,
        maxRetries: 0,
        ...(signal ? { signal } : {}),
        onResponse: (r) => {
          status = r.status;
        },
      },
    );
  } catch (error) {
    // Thrown = before/around the request (auth resolution, transport setup) — not a provider verdict.
    return { state: "unknown", message: (error as Error).message };
  }
  if (reply.stopReason !== "error" && reply.stopReason !== "aborted") return { state: "ok" };
  const message = reply.errorMessage ?? `stopReason "${reply.stopReason}"`;
  const unauthorized = status === 401 || (status === undefined && /(^|\D)401(\D|$)/.test(message));
  return { state: unauthorized ? "rejected" : "unknown", message };
}
