/**
 * Building pi's model registry: the built-ins, an agent's `models.json` and model catalog layered over the machine's,
 * the catalog refresh, and the reads of those files a report or a deploy check needs. Which credential store an agent
 * runs it over is agent-models.ts's; registry and auth are one collection, so the model's provider auth is in scope.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type CredentialStore,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type Models,
  type ModelsStore,
  type ModelsStoreEntry,
  type Provider,
  defaultProviderAuthContext,
} from "@earendil-works/pi-ai";
import { builtinModels, builtinProviders, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AGENT_MODEL_CATALOG_FILE, AGENT_MODELS_FILE, globalHome, resolveOverridePath } from "../../paths.ts";
import { writeFileAtomic } from "../../atomic-write.ts";
import { withLockedFile } from "./locked-file.ts";

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
  return resolveOverridePath(env.FASTAGENT_MODELS_PATH) ?? join(globalHome(), AGENT_MODELS_FILE);
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

/** The models.json pi loads for an agent, and where its content came from (for a load error). */
export interface ModelsFile {
  /** A snapshot pi loads; null when the agent has no models.json. */
  path: string | null;
  /** The agent's own file, when the snapshot is a copy of it alone. */
  snapshotOf?: string;
  merged?: { machine: string; definition: string };
}

/**
 * The models.json pi loads for an agent: its own file, layered over the machine's when `machine` is on. The agent's
 * file wins a provider id outright, as a definition's skill wins a name: an agent that pins an endpoint keeps it.
 *
 * Always a SNAPSHOT named by its content, in fastagent's own home: pi reloads `modelsPath` on every refresh, and every
 * session builds its own runtime, so a live file would let turns run on an edit the control plane never read. Not in
 * the agent (so `info` writes nothing there), and not in a shared temp dir, which the OS clears while a long-running
 * process still re-reads it. Content addressing is what lets every process share the directory: a snapshot is never
 * rewritten, so no process can change what another reads. A running process keeps the content it started with; an
 * edit to either file takes effect on the next start.
 *
 * ponytail: snapshots are never pruned (one per distinct content, a few KB each) because a running process may still
 * read an old one; delete the directory while no fastagent process runs if it ever matters.
 */
async function modelsFileFor(agentDir: string, machine: boolean): Promise<ModelsFile> {
  const definition = join(agentDir, AGENT_MODELS_FILE);
  const layers = machine ? await modelLayers(agentDir) : undefined;
  if (layers) {
    const content = JSON.stringify({ providers: { ...layers.machine, ...layers.own } }, null, 2);
    return { path: snapshotFile(content), merged: { machine: layers.machinePath, definition } };
  }
  let own: string;
  try {
    own = await readFile(definition, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: null };
    throw new Error(`could not read ${definition}: ${(error as Error).message}`);
  }
  // Verbatim, so pi parses it exactly as it would the file itself.
  return { path: snapshotFile(own), snapshotOf: definition };
}

function snapshotFile(content: string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 32);
  const path = join(globalHome(), ".cache", "models", `${hash}.json`);
  // 0600: it may carry literal keys. Several processes may create the same snapshot at once.
  if (!existsSync(path)) writeFileAtomic(path, content, 0o600, true);
  return path;
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
  /** The store every credential is read from and refreshed into. */
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
  return join(globalHome(), AGENT_MODEL_CATALOG_FILE);
}

type Catalog = Record<string, ModelsStoreEntry>;

/** A catalog file as pi writes it (entries by provider), or `{}` when there is none. Read without a lock: its one
 *  writer ({@link catalogFileStore}) replaces the file whole, so a read sees the old catalog or the new one. */
async function readCatalog(path: string): Promise<Catalog> {
  if (!existsSync(path)) return {};
  return parseCatalog(await readFile(path, "utf8"), path);
}

/**
 * The one reading of a catalog file's content, for reads and writes alike. Empty is an empty catalog, as pi reads it:
 * the writer creates the file exclusively an instant before its first content, and pi's own store, which wrote these
 * files before, left one behind whenever a refresh it began wrote no entry. That is safe only because nothing writes
 * these files in place any more: a rewrite in place is read mostly as empty while it runs. Anything else that does not
 * parse is a corrupt file, and a WRITE refuses it too: serializing over it would drop every other provider's entries.
 */
function parseCatalog(content: string, path: string): Catalog {
  if (content === "") return {};
  try {
    return JSON.parse(content) as Catalog;
  } catch (error) {
    throw new Error(`model catalog ${path} is not valid JSON (${(error as Error).message}): refresh or delete it`);
  }
}

/**
 * The catalog file a refresh writes, as pi's store. It replaces pi's own file store, which rewrites the file in place
 * under its lock: a reader that takes no lock (every catalog read here, and anything else reading the file) could open
 * it cut short mid-write and blame a healthy file. Same lock as pi's, so concurrent refreshes still queue; reading
 * creates nothing, so a refresh that is refused writes no file.
 */
export function catalogFileStore(path: string): ModelsStore {
  const change = (update: (catalog: Catalog) => void, signal: AbortSignal | undefined) =>
    withLockedFile(
      path,
      async (current) => {
        const catalog = parseCatalog(current ?? "", path);
        update(catalog);
        return { result: undefined, next: JSON.stringify(catalog, null, 2) };
      },
      signal ? { signal } : {},
    );
  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      return (await readCatalog(path))[providerId];
    },
    async write(providerId, entry, options) {
      options?.signal?.throwIfAborted();
      await change((catalog) => {
        catalog[providerId] = structuredClone(entry);
      }, options?.signal);
    },
    async delete(providerId, options) {
      options?.signal?.throwIfAborted();
      await change((catalog) => {
        delete catalog[providerId];
      }, options?.signal);
    },
  };
}

/**
 * The catalog files layered into one read-only store, later files winning a (type, model id) pair. An entry pi would ignore (no
 * newer than the catalog bundled with it) is dropped before the merge, so a stale layer cannot ride a newer one's
 * date past pi's rule.
 *
 * Read here rather than handed to pi as a file: pi takes one store, and its file store creates the file (and a lock)
 * on read, which would drop an empty catalog into every agent dir that was never refreshed.
 */
async function layeredCatalog(paths: readonly string[]): Promise<InMemoryModelsStore> {
  return catalogStore(await readLayeredCatalog(paths));
}

/** A fresh store over a catalog read once: pi may write into the store it is given, so runtimes never share one. */
async function catalogStore(entries: ReadonlyMap<string, ModelsStoreEntry>): Promise<InMemoryModelsStore> {
  const store = new InMemoryModelsStore();
  for (const [provider, entry] of entries) await store.write(provider, structuredClone(entry));
  return store;
}

async function readLayeredCatalog(paths: readonly string[]): Promise<Map<string, ModelsStoreEntry>> {
  const bundledAt = getBuiltinModelDataGeneratedAt();
  const merged = new Map<string, ModelsStoreEntry>();
  for (const path of paths) {
    for (const [provider, entry] of Object.entries(await readCatalog(path))) {
      if (bundledAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= bundledAt)) continue;
      const held = merged.get(provider);
      const key = (model: { type?: string; id: string }) => `${model.type ?? "chat"}\u0000${model.id}`;
      const ids = new Set(entry.models.map(key));
      merged.set(
        provider,
        held
          ? {
              models: [...held.models.filter((model) => !ids.has(key(model))), ...entry.models],
              lastModified: Math.max(held.lastModified ?? 0, entry.lastModified ?? 0),
            }
          : entry,
      );
    }
  }
  return merged;
}

/**
 * Whether the machine's model catalog supplies this model, by the same rule every registry reads it with
 * ({@link layeredCatalog}): an entry pi would ignore supplies nothing. The one layer a deployed agent does not have.
 */
export async function inGlobalCatalog(provider: string, id: string): Promise<boolean> {
  const entry = await (await layeredCatalog([globalCatalogPath()])).read(provider);
  return entry?.models.some((model) => (model.type ?? "chat") === "chat" && model.id === id) ?? false;
}

/**
 * The model files a runtime reads, READ ONCE: `agentModels` keeps one of these per agent, so every session's runtime
 * and the control plane's catalog see the same content however the files change while serving.
 */
export interface ModelFiles {
  models?: ModelsFile;
  /** `ModelRuntime.create` options over this read; a fresh catalog store each call. */
  create(): Promise<{
    modelsPath: string | null;
    modelsStore?: ModelsStore;
    allowModelNetwork: false;
    catalogBaseUrl?: string;
  }>;
}

/** The models.json a runtime for these options loads, and which model catalog it reads. */
export async function modelRuntimeFiles(options: Omit<PiModelRuntimeOptions, "credentials">): Promise<ModelFiles> {
  const { agentDir } = options;
  const machine = options.machineLayer !== false;
  const models = agentDir ? await modelsFileFor(agentDir, machine) : undefined;
  const catalogs = !agentDir
    ? []
    : [...(machine ? [globalCatalogPath()] : []), join(agentDir, AGENT_MODEL_CATALOG_FILE)];
  const catalog = !options.catalogFile && agentDir ? await readLayeredCatalog(catalogs) : undefined;
  return {
    ...(models ? { models } : {}),
    create: async () => ({
      modelsPath: models?.path ?? null,
      // Always a store of our own whenever modelsPath is set: pi's default is a file at
      // `<dirname(modelsPath)>/models-store.json`. Without a directory, pi keeps an empty one in memory.
      ...(options.catalogFile
        ? { modelsStore: catalogFileStore(options.catalogFile) }
        : catalog
          ? { modelsStore: await catalogStore(catalog) }
          : {}),
      // Never fetched while a runtime is built: serving stays offline and reproducible. A refresh is asked for.
      allowModelNetwork: false,
      ...(options.catalogBaseUrl ? { catalogBaseUrl: options.catalogBaseUrl } : {}),
    }),
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
    modelsStore: options.catalogFile
      ? catalogFileStore(options.catalogFile)
      : await layeredCatalog([globalCatalogPath()]),
    allowModelNetwork: false,
    ...(options.catalogBaseUrl ? { catalogBaseUrl: options.catalogBaseUrl } : {}),
  });
  const error = runtime.getError();
  if (error) throw new Error(error);
  return runtime;
}

/** How long a catalog refresh may take, as `pi update --models` allows. */
const CATALOG_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Fetch the model catalog of every provider the runtime can authenticate into `catalogFile` ({@link
 * catalogFileStore}): the refresh `pi update --models` runs. `build` makes the runtime over that file, and runs only
 * once the refresh is known to go ahead. A refusal writes nothing: the store creates the file only when pi writes an
 * entry. pi asks pi.dev only for a provider with a usable credential, and may refresh an expired OAuth token of the
 * runtime's store to get one. Rejects, naming each provider that failed, when any part fails, when it outlasts 15
 * seconds, when `PI_OFFLINE` is set, when the catalog file is corrupt, and when no provider has a usable credential (the
 * refresh would ask for nothing).
 */
export async function refreshCatalog(
  catalogFile: string,
  build: (catalogFile: string) => Promise<ModelRuntime>,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  // pi skips its own background refresh under PI_OFFLINE, but an explicit `allowNetwork: true` overrides that.
  if (process.env.PI_OFFLINE !== undefined) throw new Error("PI_OFFLINE is set, so the model catalog is not refreshed");
  // A corrupt file fails here, once, by its own message: past this point every provider's refresh reads the store and
  // would repeat it, worded as that provider's failure.
  await readCatalog(catalogFile);
  const runtime = await build(catalogFile);
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
 * What satisfies a provider from `env` alone (its API-key variable, or an ambient source such as an AWS profile), by
 * pi's own check, or undefined. Passed explicitly rather than read from `process.env`: only the environment a SHELL
 * hands down is shared by every agent on the machine, and a process that has loaded an agent's `.secrets/.env` holds
 * that agent's variables too. What the shell shares outranks the global credentials file (agent-models.ts),
 * so a global login for such a provider is not used.
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

/** Pi registration starts background refreshes; wait for all of them before publishing this fresh runtime. */
export async function withModelRegistration<T>(runtime: ModelRuntime, register: () => Promise<T>): Promise<T> {
  const refresh = runtime.refresh;
  const refreshes: Array<ReturnType<ModelRuntime["refresh"]>> = [];
  runtime.refresh = (...args) => {
    const pending = refresh.apply(runtime, args);
    refreshes.push(pending);
    return pending;
  };
  try {
    const result = await register();
    await Promise.all(refreshes);
    return result;
  } finally {
    runtime.refresh = refresh;
  }
}

/**
 * A registry over the given credential store. What an agent runs on is built through `agentModels`
 * (agent-models.ts); this is for a registry over some OTHER store: none at all (`models`, a deploy check of what
 * ships), a trial key under test (login), or the catalog file a refresh writes.
 */
export async function createPiModelRuntime(
  options: PiModelRuntimeOptions & { files?: ModelFiles },
): Promise<ModelRuntime> {
  const { models, create } = options.files ?? (await modelRuntimeFiles(options));
  const runtime = await ModelRuntime.create({ credentials: options.credentials, ...(await create()) });
  // A malformed models.json does NOT throw upstream — `create` resolves with the built-ins and parks the reason in
  // getError().
  const error = runtime.getError();
  if (error) {
    const origin = models?.merged
      ? `\n\nThat file merges ${models.merged.machine} with ${models.merged.definition} (the agent's own wins a provider id).`
      : models?.snapshotOf
        ? `\n\nThat file is ${models.snapshotOf} as read at startup.`
        : "";
    throw new Error(`${error}${origin}`);
  }
  await withModelRegistration(runtime, async () => {
    for (const provider of options.providers ?? []) runtime.registerNativeProvider(provider);
  });
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

/** The providers a sign-in can target: pi's built-ins plus `extra`, composed exactly as {@link piModelsOver} does. */
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
  return (await models.getAuth(model))?.source;
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
