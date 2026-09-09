/**
 * `fastagent login`: authenticate a MODEL PROVIDER into the resolved auth file (project-level
 * `<root>/.secrets/auth.json` by default, or `--auth-path`/`FASTAGENT_AUTH_PATH`) via the same {@link
 * fastagentCredentialStore} the runtime uses (one writer, one lock/corruption semantics).
 */
import type {
  AuthEvent,
  ProviderAuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { GLOBAL_AUTH_PATH, fastagentCredentialStore } from "./auth.ts";

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

export type LoginMethod = "oauth" | "api_key";

/** The user backed out of a prompt/menu — a decision, not a failure. */
export class LoginCancelled extends Error {}

/**
 * What `loginFlow` can offer a provider interactively: an OAuth flow, an API-key ENTRY prompt, or nothing ("none" —
 * the key must come from the provider's env var).
 */
export type InteractiveLoginKind = LoginMethod | "none";

export function interactiveLoginKind(p: Provider): InteractiveLoginKind {
  if (p.auth.oauth) return "oauth";
  return p.auth.apiKey?.login ? "api_key" : "none";
}
export interface LoginResult {
  provider: string;
  method: LoginMethod;
}

/** Combine present abort signals into one (no-op when none/one). */
function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  return present.length === 0 ? undefined : present.length === 1 ? present[0] : AbortSignal.any(present);
}

/** Map pi-ai's `ProviderAuthInteraction` onto the injected {@link LoginIO}. */
function authCallbacks(
  io: LoginIO,
  userSignal: AbortSignal | undefined,
  doneSignal: AbortSignal,
): ProviderAuthInteraction {
  return {
    signal: userSignal ?? new AbortController().signal,
    prompt: async (p: AuthPrompt): Promise<string> => {
      if (p.type === "select") {
        // This branch is UNCANCELLABLE: `LoginIO.select` takes no signal, so all three the line below composes.
        const v = await io.select(
          p.message,
          p.options.map((o) => ({ value: o.id, label: o.label, hint: o.description })),
        );
        if (v === undefined) throw new LoginCancelled("cancelled");
        return v;
      }
      const signal = anySignal(p.signal, userSignal, doneSignal);
      const v = await io.prompt(p.message, { hidden: p.type === "secret", signal });
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

/** Providers offering the given method as an INTERACTIVE login (so `login` can actually run it). */
function candidatesFor(providers: Provider[], method: LoginMethod): Provider[] {
  return providers.filter((p) => (method === "oauth" ? p.auth.oauth : p.auth.apiKey?.login));
}

async function selectMethod(io: LoginIO): Promise<LoginMethod> {
  const v = await io.select("Authentication method", [
    { value: "oauth", label: "Use a subscription (OAuth)" },
    { value: "api_key", label: "Use an API key" },
  ]);
  if (v !== "oauth" && v !== "api_key") throw new LoginCancelled("no authentication method selected");
  return v;
}

/** Given a provider arg, pick the method it supports (asking only when it offers both). */
async function methodForProvider(io: LoginIO, p: Provider): Promise<LoginMethod> {
  const hasOauth = !!p.auth.oauth;
  const hasKeyLogin = !!p.auth.apiKey?.login;
  if (hasOauth && hasKeyLogin) return selectMethod(io);
  if (hasOauth) return "oauth";
  if (hasKeyLogin) return "api_key";
  throw new Error(`provider "${p.id}" has no interactive login — set its API key via the provider's env var`);
}

/** List providers for the method with their configured status, and let the user pick one. */
async function selectProvider(
  io: LoginIO,
  providers: Provider[],
  method: LoginMethod,
  store: CredentialStore,
): Promise<Provider> {
  const candidates = candidatesFor(providers, method);
  if (candidates.length === 0) throw new Error(`no provider supports ${method} login`);
  const options = await Promise.all(
    candidates.map(async (p): Promise<IoOption> => {
      const cred = await store.read(p.id);
      const auth = method === "oauth" ? p.auth.oauth : p.auth.apiKey;
      return { value: p.id, label: auth?.name ?? p.name, hint: cred ? `configured (${cred.type})` : undefined };
    }),
  );
  const id = await io.select("Select a provider", options);
  // Answers the PROVIDER, not its id: the caller needs the object, and resolving it here means the one place that can
  // fail to is the one that just offered the list.
  const chosen = candidates.find((p) => p.id === id);
  if (!chosen) throw new LoginCancelled("no provider selected");
  return chosen;
}

/** Resolve method + provider (asking only what is not given), run the login flow, and persist. */
export async function loginFlow(
  io: LoginIO,
  options: {
    provider?: string;
    method?: LoginMethod;
    authPath?: string;
    store?: CredentialStore;
    providers?: Provider[];
    signal?: AbortSignal;
  } = {},
): Promise<LoginResult> {
  const store = options.store ?? fastagentCredentialStore(options.authPath ?? GLOBAL_AUTH_PATH);
  const providers = options.providers ?? builtinProviders();

  let method: LoginMethod;
  let provider: Provider;
  if (options.provider) {
    const named = providers.find((x) => x.id === options.provider);
    if (!named) throw new Error(`unknown provider "${options.provider}"`);
    provider = named;
    method = options.method ?? (await methodForProvider(io, provider));
  } else {
    method = options.method ?? (await selectMethod(io));
    provider = await selectProvider(io, providers, method, store);
  }

  // Preflight: a no-op modify runs the refuse-corrupt / writability check BEFORE the flow.
  await store.modify(provider.id, async () => undefined);

  // Reachable even though both branches above resolved a provider.
  const auth = method === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
  if (!auth?.login) throw new Error(`provider "${provider.id}" has no ${method} login`);

  // `done` cancels any prompt left pending when login resolves (manual-code race backstop).
  const done = new AbortController();
  let credential: Credential;
  try {
    credential = await auth.login(authCallbacks(io, options.signal, done.signal));
  } finally {
    done.abort();
  }
  await store.modify(provider.id, async () => credential);
  return { provider: provider.id, method };
}
