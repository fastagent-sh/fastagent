/**
 * `fastagent login`: authenticate a model provider into fastagent's OWN `~/.fastagent/auth.json`
 * (read by {@link fastagentCredentialStore}), using pi's `AuthStorage`. An OAuth-capable provider
 * (Anthropic Claude Pro/Max, ChatGPT Codex, GitHub Copilot) runs the device/browser flow; any other
 * provider id stores an API key. The terminal IO is INJECTED ({@link LoginIO}) so the flow is testable
 * without a real OAuth round-trip or stdin.
 */
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { FASTAGENT_AUTH_PATH } from "./auth.ts";

/** Terminal interaction, injectable for tests (no real stdin/stdout or browser in unit tests). */
export interface LoginIO {
  print(line: string): void;
  /** Read a line of visible input (codes, selections). */
  prompt(message: string): Promise<string>;
  /** Read a line with no echo (API keys). */
  promptHidden(message: string): Promise<string>;
  /** Best-effort open a URL in the browser (printed regardless). */
  openUrl(url: string): void;
}

/** The slice of pi's `AuthStorage` the flow uses (so a test can pass a fake). `AuthStorage` satisfies it. */
export interface AuthStore {
  getOAuthProviders(): Array<{ id: string; name: string }>;
  login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void>;
  set(provider: string, credential: { type: "api_key"; key: string }): void;
}

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
  options.forEach((o, i) => io.print(`  ${i + 1}. ${o.label}`));
  const answer = (await io.prompt("> ")).trim();
  if (answer === "") return undefined;
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]?.id;
  return options.find((o) => o.id === answer)?.id;
}

function oauthCallbacks(io: LoginIO, signal?: AbortSignal): OAuthLoginCallbacks {
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
    onSelect: ({ message, options }) => chooseFromList(io, message, options),
    onProgress: (message) => io.print(`  ${message}`),
    signal,
  };
}

/**
 * Resolve the provider (argument or interactive select among the OAuth providers), then either run
 * the OAuth flow (OAuth-capable provider) or prompt for and store an API key (any other id). Both
 * persist to `~/.fastagent/auth.json` via `AuthStorage`.
 */
export async function loginFlow(
  io: LoginIO,
  options: { provider?: string; authPath?: string; store?: AuthStore; signal?: AbortSignal } = {},
): Promise<LoginResult> {
  const store: AuthStore = options.store ?? AuthStorage.create(options.authPath ?? FASTAGENT_AUTH_PATH);
  const oauthProviders = store.getOAuthProviders();

  let provider = options.provider;
  if (!provider) {
    provider = await chooseFromList(
      io,
      "Which provider? (or `fastagent login <provider>` to set an API key)",
      oauthProviders.map((p) => ({ id: p.id, label: `${p.name} (${p.id})` })),
    );
    if (!provider) throw new Error("no provider selected");
  }

  if (oauthProviders.some((p) => p.id === provider)) {
    await store.login(provider, oauthCallbacks(io, options.signal));
    return { provider, method: "oauth" };
  }

  const key = (await io.promptHidden(`API key for "${provider}": `)).trim();
  if (!key) throw new Error(`no API key entered for "${provider}"`);
  store.set(provider, { type: "api_key", key });
  return { provider, method: "api_key" };
}
