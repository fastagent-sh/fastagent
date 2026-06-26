/**
 * `fastagent login`: authenticate a model provider into fastagent's OWN `~/.fastagent/auth.json` via
 * the SAME {@link fastagentCredentialStore} the runtime uses — ONE writer over the file, ONE
 * corruption/lock semantics. The OAuth device/browser flow comes from pi-ai/oauth
 * (`getOAuthProvider().login`); the result is persisted with `store.modify`, which refuses to clobber a
 * corrupt file — so a failed save fails visibly without any extra reconciliation machinery. An
 * OAuth-capable provider (Anthropic Claude Pro/Max, ChatGPT Codex, GitHub Copilot) runs the flow; any
 * other provider id stores an API key.
 *
 * Why not pi's `AuthStorage`: the runtime resolves auth through pi-ai's `CredentialStore` port (Models
 * consumes it), and pi ships no file-backed `CredentialStore` — so `fastagentCredentialStore` is
 * mandatory and already owns the file. `AuthStorage` is pi-coding-agent's CLI-world manager (a
 * different port, record-don't-throw persistence); routing login through it put two stores over one
 * file. Login joins the engine-world store instead.
 *
 * The terminal IO and the OAuth flow are INJECTED ({@link LoginIO}, {@link OAuthFlow}) so the routing
 * is testable against a real store without real stdin or a real OAuth round-trip.
 */
import type { Credential, CredentialStore, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { getOAuthProvider, getOAuthProviderInfoList } from "@earendil-works/pi-ai/oauth";
import { FASTAGENT_AUTH_PATH, fastagentCredentialStore } from "./auth.ts";

/** Terminal interaction, injectable for tests (no real stdin/stdout or browser in unit tests). */
export interface LoginIO {
  print(line: string): void;
  /** Read a line of visible input (codes, selections); rejects if `signal` aborts (cancellable paste). */
  prompt(message: string, signal?: AbortSignal): Promise<string>;
  /** Read a line with no echo (API keys). */
  promptHidden(message: string): Promise<string>;
  /** Best-effort open a URL in the browser (printed regardless). */
  openUrl(url: string): void;
}

/** The OAuth device/browser flow for a provider — injected so the routing is testable without a round-trip. */
export type OAuthFlow = (providerId: string, callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;

const defaultOAuthFlow: OAuthFlow = (providerId, callbacks) => {
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new Error(`unknown OAuth provider "${providerId}"`);
  return provider.login(callbacks);
};

export interface LoginResult {
  provider: string;
  method: "oauth" | "api_key";
}

/** Present a numbered list; accept a number or a literal id; undefined on an empty answer (cancel). */
async function chooseFromList(
  io: LoginIO,
  message: string,
  options: Array<{ id: string; label: string }>,
): Promise<string | undefined> {
  io.print(message);
  options.forEach((o, i) => {
    io.print(`  ${i + 1}. ${o.label}`);
  });
  const answer = (await io.prompt("> ")).trim();
  if (answer === "") return undefined;
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]?.id;
  return options.find((o) => o.id === answer)?.id;
}

/**
 * pi's anthropic/codex `onAuth` tells the user they may paste the redirect URL from another machine,
 * but that paste is only offered CONCURRENTLY with the local callback server when `onManualCodeInput`
 * is wired — otherwise the flow blocks on the server and the instruction is an empty promise. We wire
 * it to a cancellable prompt (`manualPromptSignal`): a browser/server win leaves that prompt pending,
 * so the caller aborts the signal to cancel it instead of hanging the one-shot CLI on stdin.
 */
function oauthCallbacks(io: LoginIO, manualPromptSignal: AbortSignal, signal?: AbortSignal): OAuthLoginCallbacks {
  return {
    onAuth: ({ url, instructions }) => {
      io.print(`Open this URL to authorize:\n  ${url}`);
      if (instructions) io.print(instructions);
      io.openUrl(url);
    },
    onDeviceCode: ({ userCode, verificationUri }) => {
      io.print(`Go to ${verificationUri} and enter the code:  ${userCode}`);
      io.openUrl(verificationUri);
    },
    onPrompt: ({ message }) => io.prompt(message),
    onManualCodeInput: () =>
      io.prompt("…or paste the final redirect URL here if your browser is on another machine: ", manualPromptSignal),
    onSelect: ({ message, options }) => chooseFromList(io, message, options),
    onProgress: (message) => io.print(`  ${message}`),
    signal,
  };
}

/**
 * Resolve the provider (argument or interactive select among the OAuth providers), then either run the
 * OAuth flow or prompt for an API key, and persist via `store.modify`. The persist refuses to overwrite
 * a corrupt file, so it fails visibly on its own; a no-op `modify` up front runs that same check BEFORE
 * the OAuth round-trip / key prompt, so a known-bad file fails fast instead of after the user's work.
 */
export async function loginFlow(
  io: LoginIO,
  options: {
    provider?: string;
    authPath?: string;
    store?: CredentialStore;
    oauthFlow?: OAuthFlow;
    signal?: AbortSignal;
  } = {},
): Promise<LoginResult> {
  const store = options.store ?? fastagentCredentialStore(options.authPath ?? FASTAGENT_AUTH_PATH);
  const oauthFlow = options.oauthFlow ?? defaultOAuthFlow;
  const oauthProviders = getOAuthProviderInfoList();

  let provider = options.provider;
  if (!provider) {
    provider = await chooseFromList(
      io,
      "Which provider? (or `fastagent login <provider>` to set an API key)",
      oauthProviders.map((p) => ({ id: p.id, label: `${p.name} (${p.id})` })),
    );
    if (!provider) throw new Error("no provider selected");
  }

  // Preflight: a no-op modify runs the store's refuse-corrupt check (and surfaces an unwritable file)
  // before any OAuth round-trip or key prompt — so the user is not made to do the work only to fail.
  await store.modify(provider, async () => undefined);

  if (oauthProviders.some((p) => p.id === provider)) {
    const promptAbort = new AbortController();
    let credentials: OAuthCredentials;
    try {
      credentials = await oauthFlow(provider, oauthCallbacks(io, promptAbort.signal, options.signal));
    } finally {
      // A server/browser win leaves the concurrent manual-paste prompt pending on stdin; abort it so
      // the one-shot CLI can exit (pi does not await that prompt once the server returns a code).
      promptAbort.abort();
    }
    await store.modify(provider, async (): Promise<Credential> => ({ type: "oauth", ...credentials }));
    return { provider, method: "oauth" };
  }

  const key = (await io.promptHidden(`API key for "${provider}": `)).trim();
  if (!key) throw new Error(`no API key entered for "${provider}"`);
  await store.modify(provider, async (): Promise<Credential> => ({ type: "api_key", key }));
  return { provider, method: "api_key" };
}
