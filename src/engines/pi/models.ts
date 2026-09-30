/**
 * The pi `Models` collection — the single hub that owns BOTH model resolution (provider/modelId lookup) AND auth
 * (per-request credential resolution). fastagent builds one per opener and threads it into the engine alongside the
 * selected `model`; the two must come from the same collection so the model's provider auth is in scope.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type Credential,
  type Api,
  type CredentialStore,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type Models,
  type ModelsStoreEntry,
  type Provider,
  defaultProviderAuthContext,
} from "@earendil-works/pi-ai";
import { builtinModels, builtinProviders, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type CredentialSourceOptions,
  type FastagentAuthOptions,
  type FastagentCredentialStore,
  GLOBAL_AUTH_PATH,
  assertOneCredentialSource,
  fastagentCredentialStore,
} from "./auth.ts";
import { type AuthLayers, resolveAuthLayers } from "./config.ts";
import { AGENT_MODEL_CATALOG_FILE, AGENT_MODELS_FILE, GLOBAL_HOME_DIR, resolveOverridePath } from "../../paths.ts";
import { writeFileAtomic } from "../../atomic-write.ts";

/** The DEFINITION-LOCAL custom-endpoint file, in pi's own models.json schema (see pi's docs/models.md). */

export interface CreatePiModelsOptions extends FastagentAuthOptions, CredentialSourceOptions {
  /** Extra providers registered on top of the built-ins (same id overrides a built-in). */
  providers?: Provider[];
}

/** A `Models` with every built-in pi provider, wired to fastagent's auth. */
export function createPiModels(options: CreatePiModelsOptions = {}): Models {
  return piModelsOver(resolveCredentials(options).credentials, options.providers);
}

/** The built-ins plus `providers` (a same id replaces a built-in), over any credential store. */
export function piModelsOver(credentials: CredentialStore, providers: readonly Provider[] = []): Models {
  const models = builtinModels({ credentials, authContext: defaultProviderAuthContext() });
  for (const provider of providers) models.setProvider(provider);
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

/**
 * The MACHINE's custom-endpoint file, in the same schema as an agent's own: endpoints a person set up for this machine
 * (a local Ollama, a company gateway), which every agent here inherits the way it inherits the machine's skills.
 * `FASTAGENT_MODELS_PATH` moves it. It never ships: a deployed agent has only its definition's file.
 */
function machineModelsPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOverridePath(env.FASTAGENT_MODELS_PATH) ?? join(homedir(), GLOBAL_HOME_DIR, AGENT_MODELS_FILE);
}

/** A custom-endpoint file's providers by id, or undefined when there is no file. Strict JSON: see {@link modelLayers}. */
async function readProviders(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`could not read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const providers = (parsed as { providers?: unknown } | null)?.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    throw new Error(`${path} must hold { "providers": { ... } }`);
  }
  return providers as Record<string, unknown>;
}

/**
 * The two custom-endpoint layers of an agent, read ONCE for every reader: the file pi loads and the report of where a
 * provider came from both come from this, so what runs and what `info`/`deploy` say cannot disagree. Undefined when
 * the machine has no file: then the agent's own file goes to pi untouched.
 *
 * Read here rather than by pi, because pi loads exactly one path and its comment stripping is not reachable: while a
 * machine file exists, both files must be plain JSON.
 */
async function modelLayers(
  agentDir: string,
): Promise<{ machinePath: string; machine: Record<string, unknown>; own: Record<string, unknown> } | undefined> {
  const machinePath = machineModelsPath();
  const machine = await readProviders(machinePath);
  if (!machine) return undefined;
  return { machinePath, machine, own: (await readProviders(join(agentDir, AGENT_MODELS_FILE))) ?? {} };
}

/**
 * The models.json pi loads for an agent: its own file, layered over the machine's. The agent's file wins a provider id
 * outright, as a definition's skill wins a name: an agent that pins an endpoint keeps it.
 *
 * The merge is a SNAPSHOT named by its content, in fastagent's own home: not in the agent (so `info` writes nothing
 * there), and not in a shared temp dir, which the OS clears while a long-running process still re-reads it (pi
 * reloads `modelsPath` on every refresh). Content addressing is what lets every process share the directory: a
 * snapshot is never rewritten, so no process can change what another's refresh reads. The price is that a running
 * process keeps the snapshot it started with; an edit to either file takes effect on the next start.
 *
 * ponytail: snapshots are never pruned (one per distinct content, a few KB each) because a running process may still
 * read an old one; delete the directory while no fastagent process runs if it ever matters.
 */
async function modelsFileFor(
  agentDir: string,
): Promise<{ path: string; merged?: { machine: string; definition: string } }> {
  const definition = join(agentDir, AGENT_MODELS_FILE);
  const layers = await modelLayers(agentDir);
  if (!layers) return { path: definition };
  const content = JSON.stringify({ providers: { ...layers.machine, ...layers.own } }, null, 2);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 32);
  const path = join(homedir(), GLOBAL_HOME_DIR, ".cache", "models", `${hash}.json`);
  // 0600: it may carry literal keys. Several processes may create the same snapshot at once.
  if (!existsSync(path)) writeFileAtomic(path, content, 0o600, true);
  return { path, merged: { machine: layers.machinePath, definition } };
}

/**
 * Where an agent's custom endpoints come from, for a report: the machine file, the providers the agent inherits from
 * it, and the ones its own file overrides. Undefined when the machine has no file.
 */
export async function machineModels(
  agentDir: string,
): Promise<{ path: string; inherited: string[]; overridden: string[] } | undefined> {
  const layers = await modelLayers(agentDir);
  if (!layers) return undefined;
  const ids = Object.keys(layers.machine).sort();
  return {
    path: layers.machinePath,
    inherited: ids.filter((id) => !(id in layers.own)),
    overridden: ids.filter((id) => id in layers.own),
  };
}

/** Whether pi ships this provider id itself, so an agent resolves it without any models.json entry. */
export function isBuiltinProvider(providerId: string): boolean {
  return builtinProviders().some((provider) => provider.id === providerId);
}

export interface PiModelRuntimeOptions {
  /** The store every credential is read from and refreshed into ({@link resolveCredentials}). */
  credentials: CredentialStore;
  /** The agent dir, whose {@link AGENT_MODELS_FILE} and {@link AGENT_MODEL_CATALOG_FILE} the registry reads. */
  agentDir?: string;
  /**
   * Layer the machine under the agent (default): its models.json and its model catalog ({@link globalCatalogPath}).
   * Off for the registry a DEPLOYED agent has, which `deploy` must judge by: neither ships, so that registry is the
   * agent's own two files over the catalog bundled with pi.
   */
  machineLayer?: boolean;
  /** Extra providers for the ids the built-ins do not cover. */
  providers?: readonly Provider[];
  /**
   * Read and write THIS catalog file instead of the layered, read-only snapshot: what a refresh runs on, since the
   * refresh writes it.
   */
  catalogFile?: string;
  /** Where a catalog refresh asks instead of pi.dev: a test seam. */
  catalogBaseUrl?: string;
}

/**
 * The MACHINE's model catalog: the models pi.dev lists that are newer than the catalog bundled with pi, fetched by
 * `fastagent models --refresh -g`. Every agent here reads it under its own; like `~/.fastagent/models.json`, it
 * never ships.
 */
export function globalCatalogPath(): string {
  return join(homedir(), GLOBAL_HOME_DIR, AGENT_MODEL_CATALOG_FILE);
}

/** A catalog file as pi writes it (entries by provider), or `{}` when there is none. */
async function readCatalog(path: string): Promise<Record<string, ModelsStoreEntry>> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, ModelsStoreEntry>;
  } catch (error) {
    throw new Error(`model catalog ${path} is not valid JSON (${(error as Error).message}): refresh or delete it`);
  }
}

/**
 * The catalog files layered into one read-only store, later files winning a model id. An entry pi would ignore (no
 * newer than the catalog bundled with it) is dropped before the merge, so a stale layer cannot ride a newer one's
 * date past pi's rule.
 *
 * Read here rather than handed to pi as a file: pi takes one store, and its file store creates the file (and a lock)
 * on read, which would drop an empty catalog into every agent dir that was never refreshed.
 */
async function layeredCatalog(paths: readonly string[]): Promise<InMemoryModelsStore> {
  const bundledAt = getBuiltinModelDataGeneratedAt();
  const merged = new Map<string, ModelsStoreEntry>();
  for (const path of paths) {
    for (const [provider, entry] of Object.entries(await readCatalog(path))) {
      if (bundledAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= bundledAt)) continue;
      const held = merged.get(provider);
      const ids = new Set(entry.models.map((model) => model.id));
      merged.set(
        provider,
        held
          ? {
              models: [...held.models.filter((model) => !ids.has(model.id)), ...entry.models],
              lastModified: Math.max(held.lastModified ?? 0, entry.lastModified ?? 0),
            }
          : entry,
      );
    }
  }
  const store = new InMemoryModelsStore();
  for (const [provider, entry] of merged) await store.write(provider, entry);
  return store;
}

/** Whether the machine's model catalog lists this model: the one layer a deployed agent does not have. */
export async function inGlobalCatalog(provider: string, id: string): Promise<boolean> {
  return (await readCatalog(globalCatalogPath()))[provider]?.models.some((model) => model.id === id) ?? false;
}

/** The models.json a runtime for these options loads, and which model catalog it reads. */
async function runtimeFiles(options: Omit<PiModelRuntimeOptions, "credentials">) {
  const { agentDir } = options;
  const machine = options.machineLayer !== false;
  const models = !agentDir
    ? undefined
    : machine
      ? await modelsFileFor(agentDir)
      : { path: join(agentDir, AGENT_MODELS_FILE) };
  const catalogs = !agentDir
    ? []
    : [...(machine ? [globalCatalogPath()] : []), join(agentDir, AGENT_MODEL_CATALOG_FILE)];
  return {
    models,
    create: {
      modelsPath: models?.path ?? null,
      // Always a store of our own whenever modelsPath is set: pi's default is a file at
      // `<dirname(modelsPath)>/models-store.json`. Without a directory, pi keeps an empty one in memory.
      ...(options.catalogFile
        ? { modelsStorePath: options.catalogFile }
        : agentDir
          ? { modelsStore: await layeredCatalog(catalogs) }
          : {}),
      // Never fetched while a runtime is built: serving stays offline and reproducible. A refresh is asked for.
      allowModelNetwork: false,
      ...(options.catalogBaseUrl ? { catalogBaseUrl: options.catalogBaseUrl } : {}),
    },
  };
}

/**
 * This machine's registry, without an agent: pi's built-ins, the machine's models.json and its model catalog. What
 * `fastagent models` lists outside an agent; {@link catalogFile} is the refresh's (it writes the file).
 */
export async function machineModelRuntime(
  options: { credentials?: CredentialStore; catalogFile?: string; catalogBaseUrl?: string } = {},
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: options.credentials ?? new InMemoryCredentialStore(),
    modelsPath: machineModelsPath(),
    ...(options.catalogFile
      ? { modelsStorePath: options.catalogFile }
      : { modelsStore: await layeredCatalog([globalCatalogPath()]) }),
    allowModelNetwork: false,
    ...(options.catalogBaseUrl ? { catalogBaseUrl: options.catalogBaseUrl } : {}),
  });
  const error = runtime.getError();
  if (error) throw new Error(error);
  return runtime;
}

/**
 * Refresh the machine's catalog ({@link globalCatalogPath}) with the machine's credentials: the global credentials
 * file and the environment. See {@link refreshCatalog} for what it asks and when it rejects.
 */
export async function refreshGlobalModelCatalog(
  options: { signal?: AbortSignal; catalogBaseUrl?: string } = {},
): Promise<void> {
  const runtime = await machineModelRuntime({
    credentials: fastagentCredentialStore(GLOBAL_AUTH_PATH),
    catalogFile: globalCatalogPath(),
    ...(options.catalogBaseUrl ? { catalogBaseUrl: options.catalogBaseUrl } : {}),
  });
  await refreshCatalog(runtime, options.signal ? { signal: options.signal } : {});
}

/** How long a catalog refresh may take, as `pi update --models` allows. */
const CATALOG_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Fetch the model catalog of every provider `runtime` can authenticate into the catalog file it was built over: the
 * refresh `pi update --models` runs. pi asks pi.dev only for a provider with a usable
 * credential, and may refresh an expired OAuth token of the runtime's store to get one. Rejects, naming each provider
 * that failed, when any part fails, when it outlasts 15 seconds, when `PI_OFFLINE` is set, and when no provider has a
 * usable credential (the refresh would ask for nothing).
 */
export async function refreshCatalog(runtime: ModelRuntime, options: { signal?: AbortSignal } = {}): Promise<void> {
  // pi skips its own background refresh under PI_OFFLINE, but an explicit `allowNetwork: true` overrides that.
  if (process.env.PI_OFFLINE !== undefined) throw new Error("PI_OFFLINE is set, so the model catalog is not refreshed");
  // pi skips a provider it cannot authenticate without recording anything, so with no usable credential at all the
  // refresh would "succeed" having asked for nothing.
  const refreshable = runtime.getProviders().filter((provider) => provider.refreshModels !== undefined);
  const usable = await Promise.all(
    refreshable.map(async (provider) => (await runtime.checkAuth(provider.id)) !== undefined),
  );
  if (!usable.includes(true)) {
    throw new Error(
      "no provider has a usable credential here, so there is no model catalog to fetch — log in " +
        "(`fastagent login`) or set a provider's API key first",
    );
  }
  const timeout = AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const result = await runtime.refresh({ allowNetwork: true, force: true, signal });
  if (result.aborted) {
    throw new Error(
      options.signal?.aborted
        ? "model catalog refresh cancelled"
        : `model catalog refresh did not finish within ${CATALOG_REFRESH_TIMEOUT_MS / 1000}s`,
    );
  }
  if (result.errors.size > 0) {
    const details = [...result.errors].map(([provider, error]) => `${provider}: ${error.message}`).join("; ");
    throw new Error(`could not refresh the model catalog: ${details}`);
  }
}

/**
 * The ONE reading of a caller's credential source, for every public entry that takes `authPath` or `credentialStore`
 * (createPiModels, L1, L2, the directory opener, availableModelsFromDir, login). A supplied store is used as given;
 * otherwise the files: an agent directory's own layers ({@link resolveAuthLayers}), or, with no directory, the named
 * file or the global one. `auth` is set exactly when files are in use, for a report that names them.
 */
export function resolveCredentials(
  source: CredentialSourceOptions & FastagentAuthOptions,
  context: { agentDir?: string; providers?: readonly Provider[] } = {},
): { credentials: CredentialStore; auth?: AuthLayers } {
  assertOneCredentialSource(source);
  if (source.credentialStore) return { credentials: source.credentialStore };
  const { agentDir, providers } = context;
  const auth = agentDir ? resolveAuthLayers(agentDir, source.authPath) : { path: source.authPath ?? GLOBAL_AUTH_PATH };
  return { credentials: agentCredentialStore(auth, { agentDir, providers, warn: source.warn }), auth };
}

/**
 * The credential store an agent reads through: its own file, then the user-global one for a provider the PROJECT
 * authenticates no other way (its own auth file, a models.json key, or the environment). "No other way" is answered
 * by pi's own resolution over a runtime that has no global layer, built the first time a provider is looked up there.
 * A deployment never has the global file, so a global login that outranked, say, an `ANTHROPIC_API_KEY` in
 * `.secrets/.env` would run one credential here and a different one deployed.
 */
export function agentCredentialStore(
  auth: AuthLayers,
  options: FastagentAuthOptions & { agentDir?: string; providers?: readonly Provider[] } = {},
): FastagentCredentialStore {
  const { warn, providers = [] } = options;
  const fallback = auth.fallback;
  if (fallback === undefined) return fastagentCredentialStore(auth.path, { warn });
  let project: Promise<ModelRuntime> | undefined;
  const projectRuntime = (): Promise<ModelRuntime> => {
    project ??= (async () => {
      const runtime = await ModelRuntime.create({
        credentials: fastagentCredentialStore(auth.path, { warn }),
        ...(await runtimeFiles(options)).create,
        refreshOnCreate: false,
      });
      for (const provider of providers) runtime.registerNativeProvider(provider);
      return runtime;
    })();
    return project;
  };
  return fastagentCredentialStore(auth.path, {
    warn,
    fallbackPath: fallback,
    projectAuthenticates: async (providerId) => (await (await projectRuntime()).checkAuth(providerId)) !== undefined,
  });
}

/**
 * What satisfies a provider from `env` alone (its API-key variable, or an ambient source such as an AWS profile), by
 * pi's own check, or undefined. Passed explicitly rather than read from `process.env`: only the environment a SHELL
 * hands down is shared by every agent on the machine, and a process that has loaded an agent's `.secrets/.env` holds
 * that agent's variables too. What the shell shares outranks the global credentials file ({@link
 * agentCredentialStore}), so a global login for such a provider is not used.
 *
 * `fileExists` answers for the files a source points at (an AWS profile, Google ADC): this machine's by default, which
 * is right wherever the answer is about THIS machine. A deployment passes one that finds nothing, because no file of
 * the builder's travels with it.
 */
export async function environmentAuthSource(
  providerId: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => Promise<boolean> = defaultProviderAuthContext().fileExists,
): Promise<string | undefined> {
  const models = builtinModels({
    credentials: new InMemoryCredentialStore(),
    authContext: {
      // pi's own reading of a variable (a blank one is unset), over the given environment.
      env: async (name) => (env[name]?.trim() ? env[name] : undefined),
      fileExists,
    },
  });
  return (await models.checkAuth(providerId))?.source;
}

/**
 * What authenticates `provider` for the agent in `agentDir`, resolved exactly as its serving runtime resolves it (the
 * same store and registry `createPiAgentFromDir` builds): the ONE answer both the startup report and a deployed box's
 * `login --if-missing` give, so they cannot disagree about whether the box is logged in.
 *
 * - `source`: what satisfies it now (`OAuth`, `stored credential`, an env variable's name), after a due refresh.
 * - `path`: the file that holds the stored credential, or the one a login would write.
 * - `stored`: the kind of credential the store holds for it, usable or not.
 * - `shadowed`: an env variable that also authenticates it but goes unused, because pi lets a stored credential own
 *   its provider — a key added to a deployment's value file after the box was logged in, typically.
 *
 * `modelId` picks the model to probe with; the provider's first one otherwise (auth is provider-scoped).
 */
export async function agentAuthStatus(options: {
  agentDir: string;
  auth: AuthLayers;
  provider: string;
  modelId?: string;
}): Promise<{ source?: string; path: string; stored?: Credential["type"]; shadowed?: string }> {
  const { agentDir, auth, provider } = options;
  const credentials = agentCredentialStore(auth, { agentDir });
  const models = await createPiModelRuntime({ agentDir, credentials });
  const modelId = options.modelId ?? models.getProvider(provider)?.getModels()[0]?.id;
  const source = modelId === undefined ? undefined : await probeAuthSource(models, `${provider}/${modelId}`);
  // `read` never refreshes: this is the kind on file, whatever became of it.
  const stored = (await credentials.read(provider))?.type;
  const fromEnvironment = stored === undefined ? undefined : await environmentAuthSource(provider, process.env);
  const shadowed = source !== undefined && fromEnvironment !== source ? fromEnvironment : undefined;
  return {
    path: await credentials.layerOf(provider),
    ...(source !== undefined ? { source } : {}),
    ...(stored !== undefined ? { stored } : {}),
    ...(shadowed !== undefined ? { shadowed } : {}),
  };
}

/** The `ModelRuntime`-shaped sibling of {@link createPiModels}. */
export async function createPiModelRuntime(options: PiModelRuntimeOptions): Promise<ModelRuntime> {
  const { models, create } = await runtimeFiles(options);
  const runtime = await ModelRuntime.create({ credentials: options.credentials, ...create });
  // A malformed models.json does NOT throw upstream — `create` resolves with the built-ins and parks the reason in
  // getError().
  const error = runtime.getError();
  if (error) {
    const origin = models?.merged
      ? `\n\nThat file merges ${models.merged.machine} with ${models.merged.definition} (the agent's own wins a provider id).`
      : "";
    throw new Error(`${error}${origin}`);
  }
  for (const provider of options.providers ?? []) runtime.registerNativeProvider(provider);
  return runtime;
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
  return Object.entries(await definitionApiKeys(agentDir))
    .filter(([, apiKey]) => isLiteralKey(apiKey))
    .map(([id]) => id);
}

/**
 * How the agent's OWN models.json supplies `providerId`'s key, read from the file for the reason
 * {@link literalKeyProviders} gives: `reference` is the variable a `"$NAME"` reads (the value file must hold it),
 * `inFile` a key that travels with the definition itself (a literal, or a `"!command"` run on the box), and undefined
 * no apiKey there at all.
 */
export async function definitionKeyOf(
  agentDir: string,
  providerId: string,
): Promise<{ reference: string } | { inFile: true } | undefined> {
  const apiKey = (await definitionApiKeys(agentDir))[providerId];
  if (typeof apiKey !== "string" || apiKey === "") return undefined;
  if (apiKey.startsWith("!") || isLiteralKey(apiKey)) return { inFile: true };
  // Not a literal, so isLiteralKey's own pattern matched: there is a name to read.
  return { reference: apiKey.replaceAll("$$", "").match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/)?.[1] as string };
}

/** Each provider's `apiKey` as the agent's own models.json writes it. */
async function definitionApiKeys(agentDir: string): Promise<Record<string, unknown>> {
  const file = join(agentDir, AGENT_MODELS_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    // No custom endpoints is the normal case; anything else (unreadable, a directory) is the caller's problem.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  // Malformed JSON already threw out of createPiModelRuntime before this runs, so a parse failure here would be a
  // genuine surprise and must not be swallowed.
  const providers = (JSON.parse(raw) as { providers?: Record<string, { apiKey?: unknown }> }).providers ?? {};
  return Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, provider?.apiKey]));
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

/** The providers a sign-in can target: pi's built-ins plus `extra`, composed exactly as {@link createPiModels} does. */
export function loginProviders(extra?: readonly Provider[]): readonly Provider[] {
  return piModelsOver(new InMemoryCredentialStore(), extra).getProviders();
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
