/**
 * An agent's MODEL ENVIRONMENT as one value: the credential store its turns authenticate through, the registry they
 * resolve models against, and what authenticates a provider there. Every reader builds it through {@link agentModels}
 * — the opener and L2, the startup report and a deployed box's `login --if-missing`, `info`, the first-run picker,
 * login, the model list — so none of them can read other credential layers or another registry than the runtime
 * does. Each used to compose these parts itself, and two of those copies drifted from the rule (#636, #660).
 */
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { Credential, CredentialStore, Models, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { definitionServices } from "./agent-session-factory.ts";
import { loadExtensionPaths } from "./definition.ts";
import type { AgentDirs } from "../../contexts/resolve.ts";
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
import {
  type ModelFiles,
  createPiModelRuntime,
  environmentAuthSource,
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
   * after; session bindings use createRuntime and their own extension instances.
   */
  runtime(): Promise<ModelRuntime>;
  /** A session-local registry, before its extensions are loaded. Credentials remain shared. */
  createRuntime(): Promise<ModelRuntime>;
  /**
   * What authenticates `provider` here, resolved exactly as a turn resolves it: the ONE answer the startup report and a
   * deployed box's `login --if-missing` both give. `modelId` picks the model to probe with; the provider's first one
   * otherwise (auth is provider-scoped).
   */
  authStatus(provider: string, modelId?: string): Promise<AuthStatus>;
  /**
   * The definition's extension entry points, discovered once: what this catalog registers models from and what every
   * session of the assembly built over it loads. Empty without a directory.
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
 * The model environment of the agent in `dirs.agentDir` (or, without one, of a caller with no directory: pi's
 * built-ins over the named or global credentials file). A supplied `credentialStore` is used as given; otherwise the
 * files: the directory's own layers ({@link resolveAuthLayers}), or the named file or the global one. The working
 * directory is where the catalog loads the definition's extensions to learn their models: the one every other load in
 * the process uses ({@link definitionServices}).
 */
export function agentModels(
  dirs: AgentDirs | undefined,
  source?: { authPath?: string; credentialStore?: undefined } & FastagentAuthOptions,
  options?: AgentModelsOptions,
): AgentModels & { auth: AuthLayers };
export function agentModels(
  dirs: AgentDirs | undefined,
  source?: CredentialSourceOptions & FastagentAuthOptions,
  options?: AgentModelsOptions,
): AgentModels;
export function agentModels(
  dirs: AgentDirs | undefined,
  source: CredentialSourceOptions & FastagentAuthOptions = {},
  options: AgentModelsOptions = {},
): AgentModels {
  const { providers, machineLayer } = options;
  const agentDir = dirs?.agentDir;
  const { files, readModelFiles, store, credentials } = credentialsOf(agentDir, source, options);
  const createRuntime = async (): Promise<ModelRuntime> =>
    createPiModelRuntime({
      credentials,
      files: await readModelFiles(),
      ...(agentDir ? { agentDir } : {}),
      ...(providers ? { providers } : {}),
      ...(machineLayer !== undefined ? { machineLayer } : {}),
    });
  let discovered: Promise<readonly string[]> | undefined;
  const extensionPaths = (): Promise<readonly string[]> =>
    (discovered ??= agentDir
      ? loadExtensionPaths(agentDir, options.env ? { env: options.env } : {})
      : Promise.resolve([]));
  let registry: Promise<ModelRuntime> | undefined;
  const runtime = (): Promise<ModelRuntime> => {
    registry ??= createRuntime().then(async (models) => {
      if (dirs) {
        await definitionServices({
          dirs,
          modelRuntime: models,
          definition: { skills: [] },
          extensionPaths: await extensionPaths(),
        });
      }
      return models;
    });
    return registry;
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

/**
 * What the agent in `agentDir` authenticates through: the credential half of {@link agentModels}, for a caller that
 * builds no registry (a catalog refresh) and so needs no working directory.
 */
export function agentCredentials(
  agentDir: string,
  source: CredentialSourceOptions & FastagentAuthOptions = {},
): CredentialStore {
  return credentialsOf(agentDir, source, {}).credentials;
}

/** The credential layers, the model files they consult, and the store over them: one reading for both callers. */
function credentialsOf(
  agentDir: string | undefined,
  source: CredentialSourceOptions & FastagentAuthOptions,
  options: Pick<AgentModelsOptions, "providers" | "machineLayer">,
) {
  assertOneCredentialSource(source);
  const { providers, machineLayer } = options;
  const files = source.credentialStore
    ? undefined
    : agentDir
      ? resolveAuthLayers(agentDir, source.authPath)
      : { path: source.authPath ?? GLOBAL_AUTH_PATH };
  // The model files, read once for every runtime this agent builds: a session's and the control plane's.
  let modelFiles: Promise<ModelFiles> | undefined;
  const readModelFiles = (): Promise<ModelFiles> =>
    (modelFiles ??= modelRuntimeFiles({
      ...(agentDir ? { agentDir } : {}),
      ...(machineLayer !== undefined ? { machineLayer } : {}),
    }));
  const store: FastagentCredentialStore | undefined = files
    ? agentCredentialStore(files, readModelFiles, { providers, warn: source.warn })
    : undefined;
  const credentials = source.credentialStore ?? (store as FastagentCredentialStore);
  return { files, readModelFiles, store, credentials };
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
  let project: Promise<ModelRuntime> | undefined;
  const projectRuntime = (): Promise<ModelRuntime> => {
    project ??= (async () => {
      const runtime = await ModelRuntime.create({
        credentials: fastagentCredentialStore(auth.path, { warn }),
        ...(await (await modelFiles()).create()),
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
