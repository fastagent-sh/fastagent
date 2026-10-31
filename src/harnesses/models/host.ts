/**
 * What an embedding host calls for model credentials (sign-in-api.ts has the types): a store kept where the host
 * chooses, a sign-in in its own UI, and what authenticates a provider. Thin over what `fastagent login`, `logout` and
 * `auth check` run, so each rule keeps one implementation. The one translation between FastAgent's types and pi-ai's
 * is here, written without casts and with every function checked as a function, so it stops compiling when the two
 * drift apart.
 */
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  CredentialStore as PiCredentialStore,
} from "@earendil-works/pi-ai";
import { resolveOverridePath } from "../../paths.ts";
import type {
  CredentialStore,
  ProviderAuth,
  SignInInteraction,
  SignInOption,
  SignInRequest,
  SignInResult,
} from "../../sign-in-api.ts";
import { fastagentCredentialStore } from "./credentials.ts";
import { loginOptionsOver, loginOver } from "./login.ts";
import { modelsOver } from "./models.ts";

/** The file behind each store {@link credentialFile} made: a sign-in keeps the installation's id beside it. */
const files = new WeakMap<CredentialStore, string>();

/**
 * FastAgent's locked JSON credentials file at `path` (`~` is the home directory, a relative one resolves against the
 * working directory now). A corrupt or unreadable file rejects every call.
 */
export function credentialFile(path: string): CredentialStore {
  // Resolved once, so the credentials and the installation's id beside them stay in one directory.
  const resolved = resolveOverridePath(path);
  if (resolved === undefined) throw new Error("credentialFile needs the path of a credentials file");
  const file = fastagentCredentialStore(resolved, {
    warn: (message) => {
      throw new Error(message);
    },
  });
  const store: CredentialStore = {
    read: (provider) => file.read(provider),
    list: async () => (await file.list()).map(({ providerId, type }) => ({ provider: providerId, type })),
    modify: (provider, change) => file.modify(provider, change),
    delete: (provider) => file.delete(provider),
  };
  files.set(store, resolved);
  return store;
}

/** A host's store as pi-ai reads it. */
export function piCredentials(store: CredentialStore): PiCredentialStore {
  return {
    read: (provider) => store.read(provider),
    list: async () => (await store.list()).map(({ provider, type }) => ({ providerId: provider, type })),
    modify: (provider, change) => store.modify(provider, change),
    delete: (provider) => store.delete(provider),
  };
}

/**
 * A host's interaction as pi-ai drives it. Arrow functions, not the object as it is: both declare `prompt` and
 * `notify` as methods, whose parameters TypeScript checks in either direction, so a kind of prompt or event pi-ai adds
 * would pass unseen; a call checks it.
 */
function piInteraction(interaction: SignInInteraction): AuthInteraction {
  return {
    ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
    prompt: (prompt: AuthPrompt) => interaction.prompt(prompt),
    notify: (event: AuthEvent) => interaction.notify(event),
  };
}

/** Every sign-in of the built-in providers, by name, with what authenticates each one now. */
export function signInOptions(credentials: CredentialStore): Promise<SignInOption[]> {
  return loginOptionsOver(piCredentials(credentials));
}

/**
 * Sign in to a built-in provider and store the credential. The store is written to first, so a sign-in never runs
 * toward a store that refuses it; an API key is checked with one request before it is stored, and one the provider
 * rejects is asked for again. Aborting the interaction's signal rejects with `SignInCancelled` and stores nothing.
 */
export function signIn(request: SignInRequest): Promise<SignInResult> {
  const { credentials, provider, method, interaction, deviceId } = request;
  const file = files.get(credentials);
  return loginOver({
    provider,
    method,
    interaction: piInteraction(interaction),
    ...(file === undefined ? { credentialStore: piCredentials(credentials) } : { authPath: file }),
    ...(deviceId === undefined ? {} : { getDeviceId: () => deviceId }),
  });
}

/**
 * What a request to a built-in provider authenticates with, resolved as a message resolves it: a stored credential
 * (refreshing an OAuth token that is due, through the store's `modify`), else the environment. Undefined when nothing
 * does; rejects when resolving fails, such as a refresh the provider refused.
 */
export async function providerAuth(credentials: CredentialStore, provider: string): Promise<ProviderAuth | undefined> {
  const models = modelsOver(piCredentials(credentials));
  if (models.getProvider(provider) === undefined) throw new Error(`unknown provider "${provider}"`);
  const checked = await models.checkAuth(provider);
  if (checked === undefined) return undefined;
  const resolved = await models.getAuth(provider);
  if (resolved === undefined) return undefined;
  const source = resolved.source ?? checked.source;
  const { apiKey, baseUrl } = resolved.auth;
  // pi's null header is one a request leaves out, which is what a header not given does.
  const headers = Object.entries(resolved.auth.headers ?? {}).flatMap(([name, value]) =>
    value === null ? [] : [[name, value] as const],
  );
  return {
    type: checked.type,
    ...(source === undefined ? {} : { source }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(headers.length === 0 ? {} : { headers: Object.fromEntries(headers) }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}
