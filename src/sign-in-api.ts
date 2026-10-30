/**
 * Model credentials and provider sign-in as an embedding host sees them: FastAgent's own types, so a host keeps the
 * credentials where it chooses and runs a sign-in in its own UI without knowing the harness. Imports nothing; the
 * functions over these types are in harnesses/models/host.ts.
 */

/** One provider's credential, kept by a {@link CredentialStore} whole, as it is given. */
export type Credential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; refresh: string; expires: number; [field: string]: unknown };

/**
 * Where model credentials are kept, one per provider. `modify` is the only write, and it runs one at a time per
 * provider (across processes, where the store can): an OAuth refresh happens inside it, and a rotated refresh token
 * must never be used twice. A store it cannot read rejects; answering it as empty would let the next write replace
 * every provider's credential.
 */
export interface CredentialStore {
  /** The stored credential, possibly expired; undefined when the provider has none. */
  read(provider: string): Promise<Credential | undefined>;
  /** Which providers have a credential, and of what kind; never the secrets. */
  list(): Promise<readonly { provider: string; type: Credential["type"] }[]>;
  /** `change` returns the new credential, or undefined to leave it as it is. Resolves with what is stored after. */
  modify(
    provider: string,
    change: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;
  delete(provider: string): Promise<void>;
}

export type SignInMethod = Credential["type"];

/** One way to sign in to one provider, with what authenticates the provider now. */
export interface SignInOption {
  provider: string;
  /** The provider's name: "OpenAI", "OpenAI Codex (legacy)". */
  name: string;
  method: SignInMethod;
  /** What signing in this way is called: the provider's own label ("Sign in with ChatGPT"), else a generic one. */
  label: string;
  /** An account sign-in backed by a provider subscription. */
  subscription: boolean;
  /** Its key comes from the environment only: there is no sign-in to run. */
  external: boolean;
  /**
   * What authenticates the provider now: a stored credential (`OAuth`, `stored credential`), else the environment
   * (a variable such as `OPENAI_API_KEY`). One credential is stored per provider, so signing in with the other method
   * replaces a stored one.
   */
  status?: { type: SignInMethod; source: string };
  /** What in the environment authenticates the provider with nothing stored: what still answers after a sign-out. */
  environment?: string;
  /**
   * Why checking the environment for the provider failed: `environment` is then unknown, and so is `status` when
   * nothing is stored.
   */
  problem?: string;
}

/** A question a sign-in asks. `manual_code`: the address the browser ended on after signing in, or the code its page showed. */
export type SignInPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
);

/** What a sign-in tells the person: a page to open, a code to enter there, progress. */
export type SignInEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "progress"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    };

/**
 * How a sign-in reaches the person. `prompt` resolves with the answer (a select's option `id`); it rejects with
 * {@link SignInCancelled} when the person backs out, which ends the sign-in with that error, and with any other error
 * when asking failed, which fails the sign-in with it. A prompt's `signal` aborts when the sign-in no longer needs the
 * answer, such as a `manual_code` question a browser callback answered first.
 */
export interface SignInInteraction {
  signal?: AbortSignal;
  prompt(prompt: SignInPrompt): Promise<string>;
  notify(event: SignInEvent): void;
}

export interface SignInRequest {
  credentials: CredentialStore;
  provider: string;
  method: SignInMethod;
  interaction: SignInInteraction;
  /**
   * A stable id of this installation, which Sign in with ChatGPT requires. `credentialFile` keeps one beside its
   * file; a store of the host's own passes it here.
   */
  deviceId?: string;
}

export interface SignInResult {
  provider: string;
  method: SignInMethod;
  /** An API key is checked with one request before it is stored: accepted, or not decidable (stored). */
  verified: "ok" | "unknown" | "n/a";
}

/** What a request to a provider authenticates with. */
export interface ProviderAuth {
  type: SignInMethod;
  /** Where it comes from: `OAuth`, `stored credential`, an environment variable's name. */
  source?: string;
  /** The key or access token a request sends. */
  apiKey?: string;
  /** Headers a request sends, where the provider authenticates by them (an `Authorization` of its own). */
  headers?: Record<string, string>;
  /** Where the request goes, where the credential decides it (an enterprise endpoint). */
  baseUrl?: string;
}

/** The person backed out of a sign-in, or its signal aborted: a decision, not a failure. Nothing was stored. */
export class SignInCancelled extends Error {
  override name = "SignInCancelled";
}
