/**
 * The pi `Models` collection — the single hub that owns BOTH model resolution (provider/modelId
 * lookup) AND auth (per-request credential resolution). fastagent builds one per opener and threads
 * it into the engine alongside the selected `model`; the two must come from the same collection so
 * the model's provider auth is in scope.
 */
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type Model, type Models, type Provider, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type FastagentAuthOptions, fastagentCredentialStore } from "./auth.ts";
import { providerOf } from "./config.ts";
import { type InteractiveLoginKind, interactiveLoginKind } from "./login.ts";
import { AGENT_MODELS_FILE, resolveStateRoot } from "../../paths.ts";

/** The DEFINITION-LOCAL custom-endpoint file, in pi's own models.json schema (see pi's docs/models.md):
 *  declare a self-hosted / gateway endpoint as `{ providers: { <id>: { baseUrl, api, apiKey, models } } }`
 *  and select it with a `<id>/<modelId>` model spec. Keys belong in the environment — `apiKey` supports
 *  `"$ENV_VAR"` interpolation and `"!command"` — with the NAME listed in `deploy.secrets` so the value
 *  travels to the host. Living in the agent dir is the whole point: it is part of the definition, so it
 *  is baked into the deployed image. pi's MACHINE-GLOBAL `~/.pi/agent/models.json` stays unread — that
 *  one is builder-machine state, and reading it would make an agent work locally and lose its model on
 *  deploy. The NAME itself lives in the neutral paths.ts — `dev`'s watcher needs the same one, and a
 *  second spelling would let the restart scope drift from what the worker loads. */

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
 * pi's Model with the API-shape generic erased — fastagent only passes models through to the engine,
 * so the generic carries no information. One alias keeps the `any` auditable.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional variance-friendly model type, audited at this single point
export type AnyModel = Model<any>;

/**
 * The serving default for reasoning effort, pinned to what pi's TUI defaults to (its own
 * DEFAULT_THINKING_LEVEL) — NOT inherited from the engine, whose fallback is "off": an author vibes
 * at "medium" in pi and must get "medium" when served (fidelity), and pinning the value here means
 * an upstream default change in either place cannot silently alter deployments. Models that do not
 * support a level are clamped by pi per model.
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * The `ModelRuntime`-shaped sibling of {@link createPiModels} — the SAME hub semantics (built-in
 * providers + fastagent's credential store at `authPath`) in the type pi's session services require
 * (`createAgentSessionServices({ modelRuntime })`). Built-ins PLUS the agent's own
 * {@link AGENT_MODELS_FILE} when `agentDir` is given (a dir-less caller gets built-ins only), and no
 * availability network, so the model surface equals serving's.
 *
 * `ModelRuntime` also takes `Provider` INSTANCES via `registerNativeProvider` (pi 0.83); the
 * declarative file is what this rung wires because it is data that travels with the definition.
 */
export async function createPiModelRuntime(
  options: FastagentAuthOptions & {
    authPath?: string;
    /** The agent dir, whose {@link AGENT_MODELS_FILE} declares custom endpoints. Omit for built-ins only. */
    agentDir?: string;
    /** Where the dynamic model-catalog cache goes; defaults to the agent's resolved state root. */
    stateRoot?: string;
    /** Extra providers for the ids the built-ins do not cover — the CODE-shaped sibling of models.json,
     *  for what a file cannot express (minting a token per request, a test fake).
     *
     *  On an id COLLISION the file wins, not this: upstream installs a native provider as the BASE and
     *  composes the models.json entry over it. Right way round — where a deployed agent's traffic goes
     *  is a property of the definition, not of the program that embedded it — but it does mean a same-id
     *  file entry silently replaces the endpoint injected here. Use a distinct id to keep both. */
    providers?: Provider[];
  } = {},
): Promise<ModelRuntime> {
  const { agentDir } = options;
  const runtime = await ModelRuntime.create({
    credentials: fastagentCredentialStore(options.authPath, { warn: options.warn }),
    modelsPath: agentDir ? join(agentDir, AGENT_MODELS_FILE) : null,
    // MUST be set whenever modelsPath is: pi defaults this to `<dirname(modelsPath)>/models-store.json`,
    // which would write a generated cache INTO the author's agent dir — and `deploy` bakes the whole
    // tree, so it would travel into the image as stale state. Machinery belongs under the state root.
    ...(agentDir
      ? { modelsStorePath: join(options.stateRoot ?? resolveStateRoot(agentDir), "models-store.json") }
      : {}),
    allowModelNetwork: false,
  });
  // A malformed models.json does NOT throw upstream — `create` resolves with the built-ins and parks the
  // reason in getError(). Left unread, a typo'd endpoint would silently degrade to "provider not in
  // registry" at model-resolution time, i.e. the silent fallback this codebase forbids. The upstream
  // message already names both the reason and the file, so it is surfaced verbatim.
  const error = runtime.getError();
  if (error) throw new Error(error);
  for (const provider of options.providers ?? []) runtime.registerNativeProvider(provider);
  return runtime;
}

/**
 * How a model's credential will REACH a deployed agent — the question `deploy` asks, which
 * {@link probeAuthSource} cannot answer: it flattens every models.json endpoint to the display label
 * "configured API key", so a self-hosted endpoint looks credential-less to the deploy gate even when
 * its key is sitting in an env var.
 *
 * - `envVar`: an environment variable backs it, BY NAME — the shape `deploy` already understands, so
 *   the value carries as a host secret with no extra declaration from the author.
 * - `inDefinition`: the definition itself carries it (a literal `apiKey`, or a `!command` run on the
 *   host). Nothing for `deploy` to carry — and nothing to gate on either, which is the point: the
 *   `fastagent login` remedy is meaningless for a provider login cannot serve.
 *
 * Neither set = a stored credential or nothing at all; the existing auth.json / gate paths decide.
 */
export function modelCredentialCarry(runtime: ModelRuntime, spec: string): { envVar?: string; inDefinition: boolean } {
  const status = runtime.getProviderAuthStatus(providerOf(spec));
  if (!status.configured) return { inDefinition: false };
  // An env-var name is only useful downstream if it IS one: `"${A}_${B}"` interpolation resolves from
  // the environment but has no single name to carry, so it falls through to the definition-carried
  // branch, where the author's `deploy.secrets` is the mechanism.
  if (status.source === "environment" && status.label && /^[A-Z][A-Z0-9_]*$/.test(status.label)) {
    return { envVar: status.label, inDefinition: false };
  }
  return { inDefinition: status.source !== "stored" };
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
