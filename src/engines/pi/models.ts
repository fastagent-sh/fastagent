/**
 * The pi `Models` collection — the single hub that owns BOTH model resolution (provider/modelId
 * lookup) AND auth (per-request credential resolution). fastagent builds one per opener and threads
 * it into the harness alongside the selected `model`; the two must come from the same collection so
 * the model's provider auth is in scope.
 */
import { type Api, type Model, type Models, type Provider, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type FastagentAuthOptions, fastagentCredentialStore } from "./auth.ts";
import { type InteractiveLoginKind, interactiveLoginKind } from "./login.ts";

export interface CreatePiModelsOptions extends FastagentAuthOptions {
  /** Credentials file path. Defaults to the global `~/.fastagent/.secrets/auth.json`; the directory opener passes
   *  the project-level `<root>/.secrets/auth.json`. */
  authPath?: string;
  /** Extra providers registered on top of the built-ins (same id overrides a built-in). */
  providers?: Provider[];
}

/**
 * A `Models` with every built-in pi provider, wired to fastagent's auth: stored credentials from the
 * {@link CreatePiModelsOptions.authPath} file (via {@link fastagentCredentialStore}; the global
 * `~/.fastagent/.secrets/auth.json` unless the opener passes a project-level path), then ambient env vars. A
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
 * The `ModelRuntime`-shaped sibling of {@link createPiModels} — the SAME hub semantics (built-in
 * providers + fastagent's credential store at `authPath`) in the type pi's session services require
 * (`createAgentSessionServices({ modelRuntime })`). Builtins only (`modelsPath: null` — pi's
 * machine-global models.json is definition-foreign) and no availability network, so the model
 * surface equals serving's. No `providers` option: `ModelRuntime` registers providers by config
 * record, not `Provider` instance — accepting the option and dropping it would be a silent no-op;
 * add the mapping when a consumer actually needs it.
 */
export function createPiModelRuntime(
  options: FastagentAuthOptions & { authPath?: string } = {},
): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials: fastagentCredentialStore(options.authPath, { warn: options.warn }),
    modelsPath: null,
    allowModelNetwork: false,
  });
}

/** Per-provider auth status for the first-run model picker: usable now (with the source label), not
 *  configured, or configured-but-broken (expired token, refresh failure, corrupt store — kept as DATA
 *  so the picker can show it instead of silently dropping the provider). Non-ready states carry the
 *  provider's {@link InteractiveLoginKind}, so the picker's hint predicts what picking does — an
 *  OAuth login, an API-key prompt, or (env-key-only providers) neither. */
export type ProviderAuthStatus =
  | { state: "ready"; source?: string }
  | { state: "unconfigured"; login: InteractiveLoginKind }
  | { state: "broken"; message: string; login: InteractiveLoginKind };

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

/** Verdict of {@link probeApiKey}: `rejected` is DEFINITIVE (the provider answered HTTP 401 — the key
 *  is wrong); everything else non-ok is `unknown` — a 403 can be a VALID key without model permission,
 *  a 429/5xx/network failure says nothing about the key — so callers must only destroy state on
 *  `rejected`. */
export type KeyProbe = { state: "ok" } | { state: "rejected" | "unknown"; message: string };

/**
 * Quick-fail probe for a just-stored API key: one minimal real request through the standard auth
 * resolution path (the same path invokes take), so a mistyped key surfaces at login time, not at the
 * first turn. `complete` reports provider errors as `stopReason: "error"` rather than throwing; the
 * HTTP status arrives via `onResponse` — when a provider path never calls it (SDK transports), fall
 * back to a conservative "401" match in the error text. Short timeout, no retries: feedback speed
 * over transient-failure tolerance (a transient lands on `unknown`, which keeps the key).
 */
export async function probeApiKey(models: Models, model: Model<Api>): Promise<KeyProbe> {
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
