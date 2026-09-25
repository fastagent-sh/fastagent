/**
 * Signing in to a MODEL PROVIDER, for any front end: {@link login} runs one provider's flow over pi-ai's own
 * `AuthInteraction` and persists the credential through the same {@link fastagentCredentialStore} the runtime reads
 * (one writer, one lock/corruption semantics); {@link loginOptions} is the list a picker offers. `fastagent login` is
 * one front end ({@link loginFlow}: terminal menus, then {@link login}); a GUI client is another.
 */
import {
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type Credential,
  InMemoryCredentialStore,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { fastagentCredentialStore } from "./auth.ts";
import { interactiveAuth, loginProviders, piModelsOver, probeApiKey } from "./models.ts";

export type LoginMethod = "oauth" | "api_key";

/** The user backed out of a prompt/menu, or the flow was aborted — a decision, not a failure. */
export class LoginCancelled extends Error {}

/** One provider sign-in a picker can offer. */
export interface LoginOption {
  provider: string;
  method: LoginMethod;
  /** The method's own name, e.g. "Anthropic (Claude Pro/Max)" or "Anthropic API key". */
  label: string;
  /** An OAuth login backed by a provider subscription. */
  subscription: boolean;
  /**
   * What the file holds for this provider now. It keeps ONE credential per provider, so signing in with the other
   * method replaces it — worth a warning in a client.
   */
  stored?: LoginMethod;
}

/**
 * Every interactive sign-in of pi's built-in providers, with what `authPath` already holds for each. A provider whose
 * key can only come from its env var offers none and is left out.
 */
export function loginOptions(authPath: string): Promise<LoginOption[]> {
  return loginOptionsOver(authPath);
}

/** {@link loginOptions} over pi's built-ins plus `providers` (a same id replaces one). Not public: a test seam. */
export async function loginOptionsOver(authPath: string, providers?: readonly Provider[]): Promise<LoginOption[]> {
  // ONE read of the file: `list` is metadata only, and reading per provider would repeat a corrupt file's warning for
  // every provider.
  const held = new Map(
    (await fastagentCredentialStore(authPath).list()).map((info) => [info.providerId, info.type] as const),
  );
  const offered: LoginOption[] = [];
  for (const provider of loginProviders(providers)) {
    const methods = (["oauth", "api_key"] as const).filter((method) => interactiveAuth(provider, method));
    if (methods.length === 0) continue;
    const stored = held.get(provider.id);
    for (const method of methods) {
      offered.push({
        provider: provider.id,
        method,
        label: interactiveAuth(provider, method)?.name ?? provider.name,
        subscription: method === "oauth" && provider.auth.oauth?.isSubscription === true,
        ...(stored ? { stored } : {}),
      });
    }
  }
  return offered;
}

export interface LoginRequest {
  provider: string;
  method: LoginMethod;
  /** The credentials file the sign-in is written to. */
  authPath: string;
  /** pi-ai's own interaction: prompts (`text`, `secret`, `select`, `manual_code`) and events (`auth_url`, …). */
  interaction: AuthInteraction;
}

export interface LoginResult {
  provider: string;
  method: LoginMethod;
  /** An API key checked with one minimal request: accepted, or not decidable (kept). OAuth needs no check. */
  verified: "ok" | "unknown" | "n/a";
}

/** Combine present abort signals into one (no-op when none/one). */
function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  return present.length === 0 ? undefined : present.length === 1 ? present[0] : AbortSignal.any(present);
}

/**
 * Sign in to one of pi's built-in providers and persist the credential to `authPath`.
 *
 * The file is checked FIRST (a no-op write runs the refuse-corrupt and writability checks), so a flow never runs
 * toward a credential that could not be saved. An entered API key is verified with one minimal request to the
 * provider's first model BEFORE it is written. Credentials are provider-scoped, so any model answers the question the
 * check asks (does the provider refuse the key, HTTP 401); a key the provider rejects is never stored, and the
 * provider's key flow runs again (the provider and method were not the mistake). Progress and outcome go out through
 * `interaction.notify`.
 *
 * Aborting `interaction.signal` at any point, the verification included, rejects with {@link LoginCancelled} and
 * writes nothing. Every prompt carries a signal that aborts on it, on the prompt's own signal (a callback server
 * beating a `manual_code` prompt), and when the flow settles with a prompt still pending.
 */
export function login(request: LoginRequest): Promise<LoginResult> {
  return loginOver(request);
}

/** Not public: what the CLI and the tests add to {@link login}. */
export interface LoginInternals {
  /** Providers added to pi's built-ins (a same id replaces one): a test seam. */
  providers?: readonly Provider[];
  /**
   * A model spec to verify an entered key with, when login's registry has it as one of this provider's models: the
   * first-run picker's choice, the request the agent is about to make. Otherwise the provider's first model is used,
   * which answers the 401 question as well; this only spares a first model that rejects a minimal request.
   */
  verifyWith?: string;
}

/** {@link login}, plus {@link LoginInternals}. */
export async function loginOver(request: LoginRequest, internals: LoginInternals = {}): Promise<LoginResult> {
  const { providers, verifyWith } = internals;
  const { method, authPath, interaction } = request;
  const provider = loginProviders(providers).find((p) => p.id === request.provider);
  if (!provider) throw new Error(`unknown provider "${request.provider}"`);
  const auth = interactiveAuth(provider, method);
  if (!auth?.login) throw new Error(`provider "${provider.id}" has no interactive ${method} login`);
  // The key under test lives here, not in the file, until it passes.
  const trial = new InMemoryCredentialStore();
  const models = piModelsOver(trial, providers);
  const store = fastagentCredentialStore(authPath);
  await store.modify(provider.id, async () => undefined);
  const signal = interaction.signal ?? new AbortController().signal;
  const notify = (event: AuthEvent) => interaction.notify(event);

  for (;;) {
    const credential = await runFlow(auth.login.bind(auth), interaction, signal);
    let verified: LoginResult["verified"] = "n/a";
    if (method === "api_key") {
      await trial.modify(provider.id, async () => credential);
      const verdict = await verifyApiKey(models, provider.id, verifyWith, notify, signal);
      if (signal.aborted) throw new LoginCancelled("cancelled");
      if (verdict === "rejected") continue;
      verified = verdict;
    }
    await store.modify(provider.id, async () => credential);
    return { provider: provider.id, method, verified };
  }
}

async function runFlow(
  flow: (interaction: AuthInteraction & { signal: AbortSignal }) => Promise<Credential>,
  interaction: AuthInteraction,
  signal: AbortSignal,
): Promise<Credential> {
  if (signal.aborted) throw new LoginCancelled("cancelled");
  const done = new AbortController();
  let credential: Credential;
  try {
    credential = await flow({
      signal,
      prompt: (prompt: AuthPrompt) =>
        interaction.prompt({ ...prompt, signal: anySignal(prompt.signal, signal, done.signal) } as AuthPrompt),
      notify: (event: AuthEvent) => interaction.notify(event),
    });
  } catch (error) {
    // Whatever the provider made of the abort (its own error, a rejected prompt), it was the caller's decision.
    if (signal.aborted) throw new LoginCancelled("cancelled");
    throw error;
  } finally {
    done.abort();
  }
  // A provider that ignored the abort and finished anyway: the caller still cancelled.
  if (signal.aborted) throw new LoginCancelled("cancelled");
  return credential;
}

/** One minimal request with the key under test. */
async function verifyApiKey(
  models: Models,
  providerId: string,
  verifyWith: string | undefined,
  notify: (event: AuthEvent) => void,
  signal: AbortSignal,
): Promise<"ok" | "rejected" | "unknown"> {
  const preferred = verifyWith?.startsWith(`${providerId}/`)
    ? models.getModel(providerId, verifyWith.slice(providerId.length + 1))
    : undefined;
  const model = preferred ?? models.getProvider(providerId)?.getModels()[0];
  if (!model) {
    notify({
      type: "info",
      message: `cannot verify the key: provider "${providerId}" lists no models — kept as entered`,
    });
    return "unknown";
  }
  const label = `${model.provider}/${model.id}`;
  notify({ type: "progress", message: `verifying the key with ${label}…` });
  const probe = await probeApiKey(models, model, signal);
  if (signal.aborted) return "unknown"; // the caller reports the cancel, not a verdict on the key
  if (probe.state === "ok") {
    notify({ type: "info", message: `key verified — ${label} responded` });
  } else if (probe.state === "rejected") {
    notify({
      type: "info",
      message: `${providerId} rejected the API key (HTTP 401): ${probe.message} — enter it again (or cancel)`,
    });
  } else {
    notify({
      type: "info",
      message: `could not verify the key with ${label}: ${probe.message} — kept; invokes surface the provider's error`,
    });
  }
  return probe.state;
}

// ── The terminal front end ────────────────────────────────────────────────────

/** One picker option: a stable `value`, a human `label`, and an optional `hint` (e.g. configured status). */
export interface IoOption {
  value: string;
  label: string;
  hint?: string;
}

/** Terminal interaction, injectable for tests (no real stdin/stdout or browser). */
export interface LoginIO {
  /** Single-choice picker. */
  select(message: string, options: IoOption[]): Promise<string | undefined>;
  /** Free-text or hidden input. */
  prompt(message: string, opts?: { hidden?: boolean; signal?: AbortSignal }): Promise<string | undefined>;
  /** Print an informational line (auth URL, device code, progress). */
  note(message: string): void;
  /** Best-effort open a URL in the browser (printed regardless). */
  openUrl(url: string): void;
}

/** {@link LoginIO} as pi-ai's `AuthInteraction`: what {@link login} drives for the terminal. */
function terminalInteraction(io: LoginIO, signal: AbortSignal | undefined): AuthInteraction {
  return {
    ...(signal ? { signal } : {}),
    prompt: async (p: AuthPrompt): Promise<string> => {
      // A select is UNCANCELLABLE here: `LoginIO.select` takes no signal.
      const v =
        p.type === "select"
          ? await io.select(
              p.message,
              p.options.map((o) => ({
                value: o.id,
                label: o.label,
                ...(o.description ? { hint: o.description } : {}),
              })),
            )
          : await io.prompt(p.message, { hidden: p.type === "secret", ...(p.signal ? { signal: p.signal } : {}) });
      if (v === undefined) throw new LoginCancelled("cancelled");
      return v;
    },
    notify: (e: AuthEvent): void => {
      if (e.type === "auth_url") {
        io.note(`Open this URL to authorize:\n  ${e.url}`);
        if (e.instructions) io.note(e.instructions);
        io.openUrl(e.url);
      } else if (e.type === "device_code") {
        io.note(`Go to ${e.verificationUri} and enter the code:  ${e.userCode}`);
        io.openUrl(e.verificationUri);
      } else {
        io.note(e.message);
      }
    },
  };
}

async function selectMethod(io: LoginIO): Promise<LoginMethod> {
  const v = await io.select("Authentication method", [
    { value: "oauth", label: "Use a subscription (OAuth)" },
    { value: "api_key", label: "Use an API key" },
  ]);
  if (v !== "oauth" && v !== "api_key") throw new LoginCancelled("no authentication method selected");
  return v;
}

/**
 * `fastagent login`: ask only what was not given (method, then provider, from {@link loginOptions} with each one's
 * stored credential), then {@link login}.
 */
export async function loginFlow(
  io: LoginIO,
  options: {
    authPath: string;
    provider?: string;
    method?: LoginMethod;
    providers?: Provider[];
    signal?: AbortSignal;
    /** {@link LoginInternals.verifyWith}. */
    verifyWith?: string;
  },
): Promise<LoginResult> {
  const offered = await loginOptionsOver(options.authPath, options.providers);
  let provider = options.provider;
  let method = options.method;
  if (provider) {
    const methods = offered.filter((o) => o.provider === provider).map((o) => o.method);
    if (methods.length === 0) {
      const known = loginProviders(options.providers).some((p) => p.id === provider);
      throw new Error(
        known
          ? `provider "${provider}" has no interactive login — set its API key via the provider's env var`
          : `unknown provider "${provider}"`,
      );
    }
    method ??= methods.length > 1 ? await selectMethod(io) : methods[0];
  } else {
    const chosenMethod = method ?? (await selectMethod(io));
    method = chosenMethod;
    const candidates = offered.filter((o) => o.method === chosenMethod);
    if (candidates.length === 0) throw new Error(`no provider supports ${chosenMethod} login`);
    provider = await io.select(
      "Select a provider",
      candidates.map((o) => ({
        value: o.provider,
        label: o.label,
        ...(o.stored ? { hint: `configured (${o.stored})` } : {}),
      })),
    );
    if (!candidates.some((o) => o.provider === provider)) throw new LoginCancelled("no provider selected");
  }
  return loginOver(
    {
      provider: provider as string,
      method: method as LoginMethod,
      authPath: options.authPath,
      interaction: terminalInteraction(io, options.signal),
    },
    {
      ...(options.providers ? { providers: options.providers } : {}),
      ...(options.verifyWith ? { verifyWith: options.verifyWith } : {}),
    },
  );
}
