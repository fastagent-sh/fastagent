/**
 * An agent's MODEL ENVIRONMENT as one value: the credential store its turns authenticate through, the registry they
 * resolve models against, and what authenticates a provider there. Every reader builds it through {@link agentModels}
 * — the opener and L2, the startup report and a deployed box's `login --if-missing`, `info`, the first-run picker,
 * login, the model list — so none of them can read other credential layers or another registry than the runtime
 * does. Each used to compose these parts itself, and two of those copies drifted from the rule (#636, #660).
 */
import { stat } from "node:fs/promises";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { Credential, CredentialStore, Models, Provider } from "@earendil-works/pi-ai";
import { liveExtensions } from "./live-extensions.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { definitionServices } from "./agent-session-factory.ts";
import { loadExtensionPaths } from "./definition.ts";
import {
  type AuthLayers,
  type CredentialSourceOptions,
  type FastagentAuthOptions,
  type FastagentCredentialStore,
  GLOBAL_AUTH_PATH,
  assertOneCredentialSource,
  fastagentCredentialStore,
  resolveAuthLayers,
} from "./auth.ts";
import { log } from "../../log.ts";
import {
  type ModelFiles,
  checkModelFiles,
  createPiModelRuntime,
  environmentAuthSource,
  modelFilePaths,
  modelRuntimeFiles,
  piModelsOver,
  probeAuthSource,
} from "./models.ts";

/** What authenticates one provider for an agent ({@link AgentModels.authStatus}). */
interface AuthStatus {
  /** What satisfies it now (`OAuth`, `stored credential`, an env variable's name), after a due refresh. */
  source?: string;
  /** Why resolving it failed (a corrupt entry, a refresh the provider refused), when it did. */
  error?: string;
  /** The file that holds the stored credential, or the one a login would write; absent over a caller's store. */
  path?: string;
  /** The kind of credential the store holds for it, usable or not. */
  stored?: Credential["type"];
  /**
   * An env variable that also authenticates it but goes unused, because pi lets a stored credential own its provider
   * — a key added to a deployment's value file after the box was logged in, typically.
   */
  shadowed?: string;
}

export interface AgentModels {
  /** The credentials files behind {@link credentials}; absent when the caller supplied its own store. */
  auth?: AuthLayers;
  credentials: CredentialStore;
  /**
   * The registry: pi's built-ins, plus (with a directory) the agent's `models.json` and model catalog over the
   * machine's, plus `providers` and extension model declarations. An unbound catalog, built on first use and shared
   * until the model files or the extensions' code change, when it is built again; session bindings use createRuntime
   * and their own extension instances.
   */
  runtime(): Promise<ModelRuntime>;
  /**
   * A session-local registry, before its extensions are loaded, over the model files as they are now (the same read
   * {@link runtime} is built from). Credentials remain shared.
   */
  createRuntime(): Promise<ModelRuntime>;
  /**
   * What authenticates `provider` here, resolved exactly as a turn resolves it: the ONE answer the startup report and a
   * deployed box's `login --if-missing` both give. `modelId` picks the model to probe with; the provider's first one
   * otherwise (auth is provider-scoped).
   */
  authStatus(provider: string, modelId?: string): Promise<AuthStatus>;
  /**
   * The definition's extension entry points, listed afresh on every call and answered only once pi's cache holds the
   * code on disk (live-extensions.ts): what this catalog registers models from and what each session of the assembly
   * built over it loads, so an extension added or edited while the agent runs is loaded from the next session on.
   * Empty without a directory.
   */
  extensionPaths(): Promise<readonly string[]>;
}

export interface AgentModelsOptions {
  /** Where `extensions/` is listed from; Node's filesystem by default. */
  env?: ExecutionEnv;
  /** Extra providers registered on top of the built-ins (a same id replaces one). */
  providers?: readonly Provider[];
  /**
   * Layer the machine's models.json and model catalog under the agent's (default). Off for the registry a DEPLOYED
   * agent has, since neither ships.
   */
  machineLayer?: boolean;
}

/**
 * The model environment of the agent in `agentDir` (or, without one, of a caller with no directory: pi's built-ins
 * over the named or global credentials file). A supplied `credentialStore` is used as given; otherwise the files:
 * the directory's own layers ({@link resolveAuthLayers}), or the named file or the global one.
 */
export function agentModels(
  agentDir: string | undefined,
  source?: { authPath?: string; credentialStore?: undefined } & FastagentAuthOptions,
  options?: AgentModelsOptions,
): AgentModels & { auth: AuthLayers };
export function agentModels(
  agentDir: string | undefined,
  source?: CredentialSourceOptions & FastagentAuthOptions,
  options?: AgentModelsOptions,
): AgentModels;
export function agentModels(
  agentDir: string | undefined,
  source: CredentialSourceOptions & FastagentAuthOptions = {},
  options: AgentModelsOptions = {},
): AgentModels {
  assertOneCredentialSource(source);
  const { providers, machineLayer } = options;
  const files = source.credentialStore
    ? undefined
    : agentDir
      ? resolveAuthLayers(agentDir, source.authPath)
      : { path: source.authPath ?? GLOBAL_AUTH_PATH };
  // The model files as they are now, for every runtime this agent builds: a session's and the control plane's.
  const layering = { ...(agentDir ? { agentDir } : {}), ...(machineLayer !== undefined ? { machineLayer } : {}) };
  const readModelFiles = liveModelFiles(modelFilePaths(layering), () => modelRuntimeFiles(layering));
  const store: FastagentCredentialStore | undefined = files
    ? agentCredentialStore(files, readModelFiles, { providers, warn: source.warn })
    : undefined;
  const credentials = source.credentialStore ?? (store as FastagentCredentialStore);
  const createRuntime = async (): Promise<ModelRuntime> =>
    createPiModelRuntime({
      credentials,
      files: await readModelFiles(),
      ...(agentDir ? { agentDir } : {}),
      ...(providers ? { providers } : {}),
      ...(machineLayer !== undefined ? { machineLayer } : {}),
    });
  // Only a definition has extensions/; the low-level paths (no directory) load none and watch nothing.
  const live = agentDir
    ? liveExtensions(agentDir, () => loadExtensionPaths(agentDir, options.env ? { env: options.env } : {}))
    : undefined;
  const loadable = (): Promise<{ paths: readonly string[]; generation: number }> =>
    live?.paths() ?? Promise.resolve({ paths: [], generation: 0 });
  const extensionPaths = async (): Promise<readonly string[]> => (await loadable()).paths;
  // The catalog registers what the extensions declare, so it is rebuilt when their code changes: what the control
  // plane lists and lets a session select is what a session would load (a model an edited extension declares).
  // The same for the model files: one read of them, the one the sessions bind.
  let registry: { generation: number; files: ModelFiles; runtime: Promise<ModelRuntime> } | undefined;
  const runtime = async (): Promise<ModelRuntime> => {
    const { paths, generation } = await loadable();
    const files = await readModelFiles();
    if (registry?.generation !== generation || registry.files !== files) {
      const built = createPiModelRuntime({
        credentials,
        files,
        ...(agentDir ? { agentDir } : {}),
        ...(providers ? { providers } : {}),
        ...(machineLayer !== undefined ? { machineLayer } : {}),
      }).then(async (models) => {
        if (agentDir)
          await definitionServices({
            cwd: agentDir,
            modelRuntime: models,
            definition: { skills: [] },
            extensionPaths: paths,
          });
        return models;
      });
      registry = { generation, files, runtime: built };
    }
    return registry.runtime;
  };
  return {
    ...(files ? { auth: files } : {}),
    credentials,
    runtime,
    createRuntime,
    extensionPaths,
    async authStatus(provider, modelId) {
      const models = await runtime();
      const id = modelId ?? models.getProvider(provider)?.getModels()[0]?.id;
      let resolved: { source?: string; error?: string } = {};
      if (id !== undefined) {
        try {
          const found = await probeAuthSource(models, `${provider}/${id}`);
          if (found !== undefined) resolved = { source: found };
        } catch (error) {
          // The first line: pi folds the request's stack into the message of a failed refresh.
          resolved = { error: String((error as Error).message).split("\n")[0] as string };
        }
      }
      // `read` never refreshes: this is the kind on file, whatever became of it.
      const stored = (await credentials.read(provider))?.type;
      const fromEnvironment = stored === undefined ? undefined : await environmentAuthSource(provider, process.env);
      const shadowed =
        resolved.source !== undefined && fromEnvironment !== resolved.source ? fromEnvironment : undefined;
      return {
        ...(store ? { path: await store.layerOf(provider) } : {}),
        ...resolved,
        ...(stored !== undefined ? { stored } : {}),
        ...(shadowed !== undefined ? { shadowed } : {}),
      };
    },
  };
}

export interface CreatePiModelsOptions extends FastagentAuthOptions, CredentialSourceOptions {
  /** Extra providers registered on top of the built-ins (same id overrides a built-in). */
  providers?: Provider[];
}

/** A `Models` with every built-in pi provider, wired to fastagent's auth. */
export function createPiModels(options: CreatePiModelsOptions = {}): Models {
  return piModelsOver(agentModels(undefined, options).credentials, options.providers);
}

/**
 * The credential store an agent reads through: its own file, then the user-global one for a provider the PROJECT
 * authenticates no other way (its own auth file, a models.json key, or the environment). "No other way" is answered
 * by pi's own resolution over a registry that has no global layer, built the first time a provider is looked up
 * there. A deployment never has the global file, so a global login that outranked, say, an `ANTHROPIC_API_KEY` in
 * `.secrets/.env` would run one credential here and a different one deployed.
 */
function agentCredentialStore(
  auth: AuthLayers,
  modelFiles: () => Promise<ModelFiles>,
  options: FastagentAuthOptions & Pick<AgentModelsOptions, "providers">,
): FastagentCredentialStore {
  const { warn, providers = [] } = options;
  const fallback = auth.fallback;
  if (fallback === undefined) return fastagentCredentialStore(auth.path, { warn });
  // Rebuilt when the model files change: a key a models.json adds authenticates its provider from then on.
  let project: { files: ModelFiles; runtime: Promise<ModelRuntime> } | undefined;
  const projectRuntime = async (): Promise<ModelRuntime> => {
    const files = await modelFiles();
    if (project?.files !== files) {
      const runtime = (async () => {
        const created = await ModelRuntime.create({
          credentials: fastagentCredentialStore(auth.path, { warn }),
          ...(await files.create()),
          refreshOnCreate: false,
        });
        for (const provider of providers) created.registerNativeProvider(provider);
        return created;
      })();
      project = { files, runtime };
    }
    return project.runtime;
  };
  return fastagentCredentialStore(auth.path, {
    warn,
    fallbackPath: fallback,
    projectAuthenticates: async (providerId) => (await (await projectRuntime()).checkAuth(providerId)) !== undefined,
  });
}

/**
 * The model files, LIVE: read again whenever one of `paths` changed since the last read (path, size and modification
 * time, as live-extensions.ts tracks `extensions/`), so a model added to `models.json`, or to a catalog by
 * `fastagent models --refresh` in any process, is selectable without a restart. The same object comes back until
 * then, which is what the registries built from it are keyed by.
 *
 * A change that does not load (malformed JSON, an unreadable file) KEEPS the files last read, and says so once per
 * change: the agent can write its own `models.json`, and a turn that failed on every message would leave it no turn
 * to repair it with. With nothing read before, there is nothing to keep, and the read throws, as at any start.
 */
function liveModelFiles(paths: readonly string[], read: () => Promise<ModelFiles>): () => Promise<ModelFiles> {
  let current: { fingerprint: string; files: ModelFiles } | undefined;
  /** The fingerprint of a change that did not load, so it is said, and tried, once. */
  let refused: string | undefined;
  let pending: Promise<ModelFiles> | undefined;
  const refresh = async (): Promise<ModelFiles> => {
    let fingerprint: string | undefined;
    let files: ModelFiles;
    try {
      fingerprint = await fingerprintFiles(paths);
      if (current && (fingerprint === current.fingerprint || fingerprint === refused)) return current.files;
      files = await read();
      await checkModelFiles(files);
    } catch (error) {
      // THE boundary between an edit and the turns running on the files before it: thrown at a start (nothing to
      // keep), said and kept from then on. A file that cannot even be stat'ed is said by its error, once.
      if (!current) throw error;
      const said = fingerprint ?? `unreadable: ${String(error)}`;
      if (said !== refused) {
        log.error(
          `[fastagent] the model files changed and do not load, so the models read before are kept until they ` +
            `are fixed: ${String(error)}`,
        );
      }
      refused = said;
      return current.files;
    }
    current = { fingerprint, files };
    refused = undefined;
    return files;
  };
  // Single-flight: concurrent reads after an edit share one read of the files.
  return () => {
    pending ??= refresh().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Each of `paths` as `path, size, mtime` (or absent), in one string that changes when any of them does. */
async function fingerprintFiles(paths: readonly string[]): Promise<string> {
  const lines = await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path);
        return `${path}\t${info.size}\t${info.mtimeMs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${path}\tabsent`;
        throw error;
      }
    }),
  );
  return lines.join("\n");
}
