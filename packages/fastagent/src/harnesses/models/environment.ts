/**
 * An agent's MODEL ENVIRONMENT as one value: the credential store its messages authenticate through, the models they
 * resolve against (models.ts), and what authenticates a provider there. Every reader builds it here (the serve, the
 * startup report, `info`, `login`, the model list), so none can read different credential layers or registries.
 */
import {
  type Credential,
  type CredentialStore,
  InMemoryCredentialStore,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  type AuthLayers,
  type FastagentAuthOptions,
  type FastagentCredentialStore,
  GLOBAL_AUTH_PATH,
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
  /**
   * What authenticates `provider` here, resolved exactly as a message resolves it: the one answer the startup report
   * and a deployed box's `login --if-missing` both give. `modelId` picks the model to probe with; the provider's first
   * one otherwise (auth is provider-scoped).
   */
  authStatus(provider: string, modelId?: string): Promise<AuthStatus>;
}

/**
 * The model environment of the agent in `agentDir` (or, without one, of a caller with no directory: the named or global
 * credentials file). Passing `authPath: null` reads no credentials file at all (environment variables only). `providers`
 * are the definition's. `environment` is the one source of the values a provider authenticates with and of the requests'
 * settings, which this process's environment never adds to.
 */
export async function modelEnvironment(
  agentDir: string | undefined,
  source: FastagentAuthOptions & { authPath?: string | null } = {},
  providers: readonly Provider[] = [],
  options: {
    environment?: Readonly<Record<string, string>>;
    /** Optional wrapper around the resolved file store (e.g. layering instance-durable storage ahead of local files). */
    credentialStore?: (fallback: CredentialStore | undefined) => CredentialStore;
  } = {},
): Promise<ModelEnvironment> {
  const environment = options.environment ?? {};
  const files =
    source.authPath === null
      ? undefined
      : agentDir
        ? resolveAuthLayers(agentDir, source.authPath)
        : { path: source.authPath ?? GLOBAL_AUTH_PATH };
  const store = files === undefined ? undefined : layeredStore(files, providers, source.warn, environment);
  const credentials: CredentialStore =
    options.credentialStore !== undefined ? options.credentialStore(store) : (store ?? new InMemoryCredentialStore());
  const models = modelsOver(credentials, providers, environment);
  return {
    ...(files ? { auth: files } : {}),
    credentials,
    models,
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
        stored === undefined ? undefined : (await environmentAuth(provider, environment, undefined, providers))?.source;
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
  environment: Readonly<Record<string, string>>,
): FastagentCredentialStore {
  const own = () => fastagentCredentialStore(auth.path, { ...(warn ? { warn } : {}) });
  if (auth.fallback === undefined) return own();
  const project = modelsOver(own(), providers, environment);
  return fastagentCredentialStore(auth.path, {
    ...(warn ? { warn } : {}),
    fallbackPath: auth.fallback,
    projectAuthenticates: async (providerId) => (await project.checkAuth(providerId)) !== undefined,
  });
}
