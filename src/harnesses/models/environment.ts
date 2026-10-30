/**
 * An agent's MODEL ENVIRONMENT as one value: the credential store its messages authenticate through, the models they
 * resolve against (models.ts) with their lists refreshed (catalog.ts), and what authenticates a provider there. Every
 * reader builds it here (the serve, the startup report, a deployed box's `login --if-missing`, `info`, `login`, the
 * model list, `deploy`'s pre-flight), so none can read other credential layers, another registry, or older lists than
 * the Agent does.
 */
import { join } from "node:path";
import type { Credential, CredentialStore, Models, Provider } from "@earendil-works/pi-ai";
import { log } from "../../log.ts";
import { resolveStateRoot } from "../../paths.ts";
import { catalogsIn } from "./catalog.ts";
import {
  type AuthLayers,
  type CredentialSourceOptions,
  type FastagentAuthOptions,
  type FastagentCredentialStore,
  GLOBAL_AUTH_PATH,
  assertOneCredentialSource,
  fastagentCredentialStore,
  resolveAuthLayers,
} from "./credentials.ts";
import { environmentAuth, modelsOver, probeAuthSource } from "./models.ts";

/** What authenticates one provider for an agent ({@link ModelEnvironment.authStatus}). */
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
   * An env variable that also authenticates it but goes unused, because a stored credential owns its provider: a key
   * added to a deployment's value file after the box was logged in, typically.
   */
  shadowed?: string;
}

export interface ModelEnvironment {
  /** The credentials files behind {@link credentials}; absent when the caller supplied its own store. */
  auth?: AuthLayers;
  credentials: CredentialStore;
  /** pi's built-ins and the definition's providers, over {@link credentials}. */
  models: Models;
  /** Why a model list is not current, when one is not (logged already): each lists what it last had. */
  catalogProblem?: string;
  /**
   * What authenticates `provider` here, resolved exactly as a message resolves it: the one answer the startup report
   * and a deployed box's `login --if-missing` both give. `modelId` picks the model to probe with; the provider's first
   * one otherwise (auth is provider-scoped).
   */
  authStatus(provider: string, modelId?: string): Promise<AuthStatus>;
}

/**
 * The model environment of the agent in `agentDir` (or, without one, of a caller with no directory: the named or global
 * credentials file). A supplied `credentialStore` is used as given; otherwise the files: the directory's own layers
 * ({@link resolveAuthLayers}), or the named file, or the global one. `providers` are the definition's. A provider's
 * key is read from `env`, the agent's environment (this process's by default). The model lists are refreshed before it
 * resolves, kept in the instance's state root (`stateRoot`, else the directory's); `force` asks the network even when
 * they are fresh.
 */
export async function modelEnvironment(
  agentDir: string | undefined,
  source: CredentialSourceOptions & FastagentAuthOptions = {},
  providers: readonly Provider[] = [],
  options: { force?: boolean; stateRoot?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ModelEnvironment> {
  const env = options.env ?? process.env;
  assertOneCredentialSource(source);
  const files = source.credentialStore
    ? undefined
    : agentDir
      ? resolveAuthLayers(agentDir, source.authPath)
      : { path: source.authPath ?? GLOBAL_AUTH_PATH };
  const store = files === undefined ? undefined : layeredStore(files, providers, source.warn, env);
  const credentials = source.credentialStore ?? (store as FastagentCredentialStore);
  const stateRoot = options.stateRoot ?? (agentDir === undefined ? undefined : resolveStateRoot(agentDir));
  const catalogs = catalogsIn(stateRoot === undefined ? undefined : join(stateRoot, "models"));
  const models = modelsOver(credentials, providers, catalogs, env);
  const catalogProblem = await catalogs.refresh(models, { force: options.force === true });
  if (catalogProblem !== undefined) log.warn(`[fastagent] ${catalogProblem}`);
  return {
    ...(files ? { auth: files } : {}),
    credentials,
    models,
    ...(catalogProblem === undefined ? {} : { catalogProblem }),
    async authStatus(provider, modelId) {
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
      const fromEnvironment =
        stored === undefined ? undefined : (await environmentAuth(provider, env, undefined, providers))?.source;
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
 * The credential store an agent reads through: its own file, then the user-global one for a provider the PROJECT
 * authenticates no other way (its own file, a provider in code that needs no key, or the environment). A deployment
 * never has the global file, so a global login that outranked, say, an `ANTHROPIC_API_KEY` in `.secrets/.env` would
 * run one credential here and a different one deployed.
 */
function layeredStore(
  auth: AuthLayers,
  providers: readonly Provider[],
  warn: FastagentAuthOptions["warn"],
  env: NodeJS.ProcessEnv,
): FastagentCredentialStore {
  const own = () => fastagentCredentialStore(auth.path, { ...(warn ? { warn } : {}) });
  if (auth.fallback === undefined) return own();
  const project = modelsOver(own(), providers, undefined, env);
  return fastagentCredentialStore(auth.path, {
    ...(warn ? { warn } : {}),
    fallbackPath: auth.fallback,
    projectAuthenticates: async (providerId) => (await project.checkAuth(providerId)) !== undefined,
  });
}
