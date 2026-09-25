/**
 * Signing in to a MODEL PROVIDER, for any front end: {@link login} runs one provider's flow over pi-ai's own
 * `AuthInteraction` and persists the credential through the same {@link fastagentCredentialStore} the runtime reads
 * (one writer, one lock/corruption semantics); {@link loginOptions} is the list a picker offers. `fastagent login` is
 * one front end ({@link loginFlow}: terminal menus, then {@link login}); a GUI client is another.
 */
import type { AuthEvent, AuthInteraction, AuthPrompt, Credential, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { fastagentCredentialStore } from "./auth.ts";
import { resolveModel } from "./config.ts";
import { createPiModels, probeApiKey } from "./models.ts";

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

/** The auth a provider runs for `method`, when it offers that method interactively. */
function interactiveAuth(provider: Provider, method: LoginMethod) {
  return method === "oauth" ? provider.auth.oauth : provider.auth.apiKey?.login ? provider.auth.apiKey : undefined;
}

/**
 * Every interactive sign-in the providers offer (pi's built-ins unless `providers` is given), with what `authPath`
 * already holds for each. A provider whose key can only come from its env var offers none and is left out.
 */
export async function loginOptions(authPath: string, options: { providers?: Provider[] } = {}): Promise<LoginOption[]> {
  const store = fastagentCredentialStore(authPath);
  const offered: LoginOption[] = [];
  for (const provider of options.providers ?? builtinProviders()) {
    const methods = (["oauth", "api_key"] as const).filter((method) => interactiveAuth(provider, method));
    if (methods.length === 0) continue;
    const stored = (await store.read(provider.id))?.type;
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
  /** The model an entered API key is verified against; default the provider's first. */
  model?: string;
  /** The providers to sign in to; default pi's built-ins. */
  providers?: Provider[];
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
 * Sign in to one provider and persist the credential to `authPath`.
 *
 * The file is checked FIRST (a no-op write runs the refuse-corrupt and writability checks), so a flow never runs
 * toward a credential that could not be saved. An entered API key is then verified with one minimal request: a key
 * the provider rejects (HTTP 401) is deleted and ONLY the key is asked again, since the provider and method were not
 * the mistake. Progress and outcome go out through `interaction.notify`.
 *
 * Aborting `interaction.signal` rejects with {@link LoginCancelled} and writes nothing. Every prompt carries a signal
 * that aborts on it, on the prompt's own signal (a callback server beating a `manual_code` prompt), and when the flow
 * settles with a prompt still pending.
 */
export async function login(request: LoginRequest): Promise<LoginResult> {
  const { method, authPath, interaction } = request;
  const provider = (request.providers ?? builtinProviders()).find((p) => p.id === request.provider);
  if (!provider) throw new Error(`unknown provider "${request.provider}"`);
  const auth = interactiveAuth(provider, method);
  if (!auth?.login) throw new Error(`provider "${provider.id}" has no interactive ${method} login`);
  const store = fastagentCredentialStore(authPath);
  await store.modify(provider.id, async () => undefined);

  for (;;) {
    const credential = await runFlow(auth.login.bind(auth), interaction);
    await store.modify(provider.id, async () => credential);
    if (method === "oauth") return { provider: provider.id, method, verified: "n/a" };
    const verdict = await verifyApiKey(provider.id, request, (event) => interaction.notify(event));
    if (verdict !== "rejected") return { provider: provider.id, method, verified: verdict };
  }
}

async function runFlow(
  flow: (interaction: AuthInteraction & { signal: AbortSignal }) => Promise<Credential>,
  interaction: AuthInteraction,
): Promise<Credential> {
  const signal = interaction.signal ?? new AbortController().signal;
  if (signal.aborted) throw new LoginCancelled("cancelled");
  const done = new AbortController();
  try {
    return await flow({
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
}

/** One minimal request with the stored key. A rejection deletes the key, so the caller asks for it again. */
async function verifyApiKey(
  providerId: string,
  request: LoginRequest,
  notify: (event: AuthEvent) => void,
): Promise<"ok" | "rejected" | "unknown"> {
  // Built-in (or given) providers only: a models.json endpoint authenticates from its own `apiKey`, so there is no
  // stored credential of its to verify here.
  const models = createPiModels({
    authPath: request.authPath,
    ...(request.providers ? { providers: request.providers } : {}),
  });
  const model = request.model ? resolveModel(models, request.model) : models.getProvider(providerId)?.getModels()[0];
  if (!model) {
    notify({
      type: "info",
      message: `cannot verify the key: provider "${providerId}" lists no models — kept as stored`,
    });
    return "unknown";
  }
  const label = `${model.provider}/${model.id}`;
  notify({ type: "progress", message: `verifying the key with ${label}…` });
  const probe = await probeApiKey(models, model);
  if (probe.state === "ok") {
    notify({ type: "info", message: `key verified — ${label} responded` });
  } else if (probe.state === "rejected") {
    await fastagentCredentialStore(request.authPath).delete(providerId);
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
    model?: string;
  },
): Promise<LoginResult> {
  const offered = await loginOptions(options.authPath, options.providers ? { providers: options.providers } : {});
  let provider = options.provider;
  let method = options.method;
  if (provider) {
    const methods = offered.filter((o) => o.provider === provider).map((o) => o.method);
    if (methods.length === 0) {
      const known = (options.providers ?? builtinProviders()).some((p) => p.id === provider);
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
  return login({
    provider: provider as string,
    method: method as LoginMethod,
    authPath: options.authPath,
    interaction: terminalInteraction(io, options.signal),
    ...(options.model ? { model: options.model } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
  });
}
