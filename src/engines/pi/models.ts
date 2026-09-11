/**
 * The pi `Models` collection — the single hub that owns BOTH model resolution (provider/modelId lookup) AND auth
 * (per-request credential resolution). fastagent builds one per opener and threads it into the engine alongside the
 * selected `model`; the two must come from the same collection so the model's provider auth is in scope.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type Model, type Models, type Provider, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type FastagentAuthOptions, fastagentCredentialStore } from "./auth.ts";
import { providerOf } from "./config.ts";
import { type InteractiveLoginKind, interactiveLoginKind } from "./login.ts";
import { AGENT_MODELS_FILE, resolveStateRoot } from "../../paths.ts";

/** The DEFINITION-LOCAL custom-endpoint file, in pi's own models.json schema (see pi's docs/models.md). */

export interface CreatePiModelsOptions extends FastagentAuthOptions {
  authPath?: string;
  /**
   * Read a provider the primary file does not have from here instead (`resolveAuthFallback`: the user-global store).
   * Omitted by an embedder that named its own store — "use this file" is an instruction, not a preference.
   */
  fallbackAuthPath?: string;
  /** Extra providers registered on top of the built-ins (same id overrides a built-in). */
  providers?: Provider[];
}

/** A `Models` with every built-in pi provider, wired to fastagent's auth. */
export function createPiModels(options: CreatePiModelsOptions = {}): Models {
  const models = builtinModels({
    credentials: fastagentCredentialStore(options.authPath, {
      warn: options.warn,
      ...(options.fallbackAuthPath !== undefined ? { fallbackPath: options.fallbackAuthPath } : {}),
    }),
    authContext: defaultProviderAuthContext(),
  });
  for (const provider of options.providers ?? []) models.setProvider(provider);
  return models;
}

/**
 * pi's Model with the API-shape generic erased — fastagent only passes models through to the engine, so the generic
 * carries no information.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional variance-friendly model type, audited at this single point
export type AnyModel = Model<any>;

/** The serving default for reasoning effort, pinned to what pi's TUI defaults to (its own DEFAULT_THINKING_LEVEL). */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/** The `ModelRuntime`-shaped sibling of {@link createPiModels}. */
export async function createPiModelRuntime(
  options: FastagentAuthOptions & {
    authPath?: string;
    /** Read a provider the primary file does not have from here instead ({@link CreatePiModelsOptions}). */
    fallbackAuthPath?: string;
    /** The agent dir, whose {@link AGENT_MODELS_FILE} declares custom endpoints. */
    agentDir?: string;
    /** Where the dynamic model-catalog cache goes; defaults to the agent's resolved state root. */
    stateRoot?: string;
    /** Extra providers for the ids the built-ins do not cover. */
    providers?: Provider[];
  } = {},
): Promise<ModelRuntime> {
  const { agentDir } = options;
  const runtime = await ModelRuntime.create({
    credentials: fastagentCredentialStore(options.authPath, {
      warn: options.warn,
      ...(options.fallbackAuthPath !== undefined ? { fallbackPath: options.fallbackAuthPath } : {}),
    }),
    modelsPath: agentDir ? join(agentDir, AGENT_MODELS_FILE) : null,
    // MUST be set whenever modelsPath is: pi defaults this to `<dirname(modelsPath)>/models-store.json`, which would
    // write a generated cache INTO the author's agent dir.
    ...(agentDir
      ? { modelsStorePath: join(options.stateRoot ?? resolveStateRoot(agentDir), "models-store.json") }
      : {}),
    allowModelNetwork: false,
  });
  // A malformed models.json does NOT throw upstream — `create` resolves with the built-ins and parks the reason in
  // getError().
  const error = runtime.getError();
  if (error) throw new Error(error);
  for (const provider of options.providers ?? []) runtime.registerNativeProvider(provider);
  return runtime;
}

/** How a model's credential will REACH a deployed agent. */
export function modelCredentialCarry(runtime: ModelRuntime, spec: string): { envVar?: string; inDefinition: boolean } {
  const status = runtime.getProviderAuthStatus(providerOf(spec));
  if (!status.configured) return { inDefinition: false };
  // An env-var name is only useful downstream if it IS one.
  if (status.source === "environment" && status.label && /^[A-Z][A-Z0-9_]*$/.test(status.label)) {
    return { envVar: status.label, inDefinition: false };
  }
  return { inDefinition: status.source !== "stored" };
}

/**
 * EVERY provider whose `models.json` entry writes its key as a LITERAL rather than a `"$NAME"` reference or a
 * `"!cmd"`. The file ships inside the image, so a literal there is a credential in a readable layer.
 *
 * Read from the FILE, not from `getProviderAuthStatus`: that answers "what satisfies this provider right now" and
 * returns `stored` first, so a provider that has both an `auth.json` entry and a literal in the file would report
 * `stored` and the literal would go unreported. The question is what the definition DECLARES, and only the file
 * answers it. The three-way split mirrors pi's `configuredRequestAuthStatus`, which is not exported.
 *
 * The caller WARNS on this; it does not refuse. Whether a given string is a credential is the author's knowledge,
 * not the framework's — pi's own docs prescribe `"apiKey": "ollama"` for a keyless local server, and no static rule
 * separates that from a leaked key (an endpoint's reachability is not decidable from its URL either). FastAgent
 * gates what IT causes; what the author wrote into their own committed file, it reports.
 */
export async function literalKeyProviders(agentDir: string): Promise<string[]> {
  const file = join(agentDir, AGENT_MODELS_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    // No custom endpoints is the normal case; anything else (unreadable, a directory) is the caller's problem.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // Malformed JSON already threw out of createPiModelRuntime before this runs, so a parse failure here would be a
  // genuine surprise and must not be swallowed.
  const providers = (JSON.parse(raw) as { providers?: Record<string, { apiKey?: unknown }> }).providers ?? {};
  return Object.entries(providers)
    .filter(([, provider]) => isLiteralKey(provider?.apiKey))
    .map(([id]) => id);
}

/**
 * `!cmd` runs on the box; `$NAME` / `${NAME}` reads the environment; anything else is the key itself.
 *
 * `$$` is pi's escape for a literal `$`, so it is removed BEFORE looking for a reference — otherwise `"sk$$abc"`
 * (which resolves to the literal `sk$abc`) would read as a reference and go unmentioned.
 */
function isLiteralKey(apiKey: unknown): boolean {
  if (typeof apiKey !== "string" || apiKey === "" || apiKey.startsWith("!")) return false;
  return !/\$\{?[A-Za-z_]/.test(apiKey.replaceAll("$$", ""));
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

/** Which source currently satisfies auth for `spec` — a startup diagnostic. */
export async function probeAuthSource(models: Models, spec: string): Promise<string | undefined> {
  const slash = spec.indexOf("/");
  if (slash < 1) return undefined;
  const model = models.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) return undefined;
  const auth = await models.getAuth(model).catch(() => undefined);
  return auth?.source;
}

/**
 * Verdict of {@link probeApiKey}: `rejected` is DEFINITIVE (the provider answered HTTP 401 — the key is wrong);
 * everything else non-ok is `unknown`.
 */
export type KeyProbe = { state: "ok" } | { state: "rejected" | "unknown"; message: string };

/** Quick-fail probe for a just-stored API key. */
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
