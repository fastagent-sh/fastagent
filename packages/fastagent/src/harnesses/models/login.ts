/**
 * Signing in to a MODEL PROVIDER for local development: {@link loginOver} runs one provider's flow over pi-ai's own
 * `AuthInteraction`, verifies entered API keys with one probe, and persists credentials through
 * {@link fastagentCredentialStore}. Terminal menu selection lives in `cli/login-ui.ts`.
 */
import { definedValues } from "../../declared-secrets.ts";
import { readProcessEnv } from "../../process-env.ts";
import {
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type Credential,
  type CredentialStore,
  InMemoryCredentialStore,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { fastagentCredentialStore } from "./credentials.ts";
import { UNNAMED_AUTH_SOURCE, interactiveAuth, loginProviders, modelsOver, probeApiKey } from "./models.ts";

export type SignInMethod = Credential["type"];

/** One way to sign in to one provider, with what authenticates the provider now. */
export interface SignInOption {
  provider: string;
  /** The provider's name: "OpenAI", "OpenAI Codex". */
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

export interface SignInResult {
  provider: string;
  method: SignInMethod;
  /** An API key is checked with one request before it is stored: accepted, or not decidable (stored). */
  verified: "ok" | "unknown" | "n/a";
}

/** The person backed out of a sign-in, or its signal aborted: a decision, not a failure. Nothing was stored. */
export class SignInCancelled extends Error {
  override name = "SignInCancelled";
}

/** A sign-in that cannot start as asked: an unknown provider, or a choice a caller without menus did not make. */
export class LoginRefused extends Error {
  /** The sign-ins it could be instead, for a caller to choose from. */
  readonly choices: readonly SignInOption[];
  constructor(message: string, choices: readonly SignInOption[]) {
    super(message);
    this.choices = choices;
  }
}

const ACCOUNT_LABEL = "Sign in with an account";
const API_KEY_LABEL = "Sign in with an API key";

/** A credentials file path names fastagent's store over it; a store is used as given. */
const storeOf = (credentials: string | CredentialStore): CredentialStore =>
  typeof credentials === "string" ? fastagentCredentialStore(credentials) : credentials;

/**
 * Every sign-in of pi's built-in providers plus `providers` (a same id replaces one), sorted by name as pi's `/login`
 * lists them, with what authenticates each one here: a credential `credentials` (a credentials file, or a store) holds,
 * else this process's environment, which a stored credential outranks.
 */
export async function loginOptionsOver(
  credentials: string | CredentialStore,
  providers?: readonly Provider[],
): Promise<SignInOption[]> {
  // ONE read of the store: `list` is metadata only, and reading per provider would repeat a corrupt file's warning for
  // every provider.
  const held = new Map((await storeOf(credentials).list()).map((info) => [info.providerId, info.type] as const));
  // The environment alone, over no store: what authenticates a provider nothing is stored for, here the host's own.
  const environment = modelsOver(new InMemoryCredentialStore(), providers, definedValues(readProcessEnv()));
  const offered: SignInOption[] = [];
  for (const provider of loginProviders(providers)) {
    const methods = (["oauth", "api_key"] as const).filter(
      (method) => provider.auth[method === "oauth" ? "oauth" : "apiKey"],
    );
    if (methods.length === 0) continue;
    const stored = held.get(provider.id);
    let ambient: SignInOption["status"];
    let problem: string | undefined;
    try {
      const found = await environment.checkAuth(provider.id);
      if (found !== undefined) ambient = { type: found.type, source: found.source ?? UNNAMED_AUTH_SOURCE };
    } catch (error) {
      problem = (error as Error).message;
    }
    const status: SignInOption["status"] =
      stored === undefined ? ambient : { type: stored, source: stored === "oauth" ? "OAuth" : "stored credential" };
    for (const method of methods) {
      offered.push({
        provider: provider.id,
        name: provider.name,
        method,
        label: method === "oauth" ? (provider.auth.oauth?.loginLabel ?? ACCOUNT_LABEL) : API_KEY_LABEL,
        subscription: method === "oauth" && provider.auth.oauth?.isSubscription === true,
        external: interactiveAuth(provider, method) === undefined,
        ...(status ? { status } : {}),
        ...(ambient ? { environment: ambient.source } : {}),
        ...(problem ? { problem } : {}),
      });
    }
  }
  return offered.sort((a, b) => a.name.localeCompare(b.name));
}

/** What a credential of `type` is called beside a provider's sign-in, as pi's picker calls it. */
function credentialKind(type: SignInMethod, subscription: boolean): string {
  if (type === "api_key") return "API key";
  return subscription ? "subscription" : "account";
}

/** An option's status as pi's picker writes it after the provider's name. */
export function loginStatusText(option: SignInOption): string {
  const { status } = option;
  // A stored credential outranks the environment, so a failed check of the environment does not decide it.
  if (status === undefined)
    return option.problem === undefined ? "not configured" : `auth check failed: ${option.problem}`;
  if (status.type !== option.method) return `${credentialKind(status.type, option.subscription)} configured`;
  if (status.source === "OAuth" || status.source === "stored credential") return "✓ configured";
  return /^[A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*$/.test(status.source)
    ? `✓ env: ${status.source}`
    : `✓ ${status.source}`;
}

export type LoginRequest = {
  /** Stable installation identity (Sign in with ChatGPT requires one); defaults to `device.json` beside `authPath`. */
  getDeviceId?: () => string;
  provider: string;
  method: SignInMethod;
  /** pi-ai's own interaction: prompts (`text`, `secret`, `select`, `manual_code`) and events (`auth_url`, …). */
  interaction: AuthInteraction;
} & (
  | {
      /** The credentials file the sign-in is written to. */
      authPath: string;
    }
  | {
      /** Direct credential store (e.g. instance durable storage) the sign-in is written to. */
      store: CredentialStore;
      /** Async provider of the durable installation device ID for OAuth flows. */
      resolveDeviceId?: () => Promise<string>;
    }
);

/** Combine present abort signals into one (no-op when none/one). */
function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  return present.length === 0 ? undefined : present.length === 1 ? present[0] : AbortSignal.any(present);
}

/** What the CLI adds to a sign-in. */
export interface LoginInternals {
  /**
   * The definition's providers, added to pi's built-ins (a same id replaces one): a key is verified against the
   * endpoint its turns will reach, which a provider in code can point at a gateway.
   */
  providers?: readonly Provider[];
  /**
   * A model spec to verify an entered key with, when the registry has it as one of this provider's models: the
   * first-run picker's choice, the request the agent is about to make. Otherwise pi's default model for the provider
   * is used, then its first. On one registry, any of a provider's models answers the 401 question.
   */
  verifyWith?: string;
  /** Provider request environment for API-key verification. Defaults to this process's defined environment values. */
  environment?: Readonly<Record<string, string>>;
}

/**
 * Sign in to one of pi's built-in providers (plus the definition's) and persist the credential to `authPath`, or to
 * the caller's `credentialStore`.
 *
 * The store is checked FIRST (a no-op write runs the file store's refuse-corrupt and writability checks, or whatever
 * the caller's store does on a write), so a flow never runs toward a credential that could not be saved. An entered API key is verified with one minimal request to pi's
 * default model for the provider (its first model when pi names none), at pi's built-in endpoint, BEFORE it is
 * written. Credentials are provider-scoped, so any of the provider's models answers the question the check asks (does
 * the provider refuse the key, HTTP 401); a key the provider rejects is never stored, and the provider's key flow runs
 * again (the provider and method were not the mistake). Progress and outcome go out through `interaction.notify`.
 *
 * Aborting `interaction.signal` at any point, the verification included, rejects with {@link SignInCancelled} and
 * writes no credential (an OAuth device ID, the installation's identity, is kept once created). Every prompt carries a
 * signal that aborts on it, on the prompt's own signal (a callback server beating a `manual_code` prompt), and when the
 * flow settles with a prompt still pending.
 */
export async function loginOver(request: LoginRequest, internals: LoginInternals = {}): Promise<SignInResult> {
  const { providers, verifyWith, environment } = internals;
  const { method, interaction } = request;
  const provider = loginProviders(providers).find((p) => p.id === request.provider);
  if (!provider) throw new Error(`unknown provider "${request.provider}"`);
  const auth = interactiveAuth(provider, method);
  if (!auth?.login) throw new Error(`provider "${provider.id}" has no interactive ${method} login`);
  const flow = auth.login.bind(auth);
  // The key under test lives here, not in the file, until it passes.
  const trial = new InMemoryCredentialStore();
  // Only a key needs the registry: it is checked with one request before it is kept.
  const models: Models | undefined =
    method === "api_key" ? modelsOver(trial, providers, environment ?? definedValues(readProcessEnv())) : undefined;
  const store = "store" in request ? request.store : fastagentCredentialStore(request.authPath);
  await store.modify(provider.id, async () => undefined);
  const signal = interaction.signal ?? new AbortController().signal;
  const notify = (event: AuthEvent) => interaction.notify(event);
  let getDeviceId = request.getDeviceId;
  if (method === "oauth" && !getDeviceId) {
    if ("store" in request) {
      if (request.resolveDeviceId !== undefined) {
        const deviceId = await request.resolveDeviceId();
        getDeviceId = () => deviceId;
      }
    } else {
      const deviceId = await deviceIdBeside(request.authPath);
      getDeviceId = () => deviceId;
    }
  }

  for (;;) {
    const credential = await runFlow(
      (io) => flow(io, getDeviceId === undefined ? {} : { getDeviceId }),
      interaction,
      signal,
    );
    let verified: SignInResult["verified"] = "n/a";
    if (models) {
      await trial.modify(provider.id, async () => credential);
      const verdict = await verifyApiKey(models, provider.id, verifyWith, notify, signal);
      if (signal.aborted) throw new SignInCancelled("cancelled");
      if (verdict === "rejected") continue;
      verified = verdict;
    }
    await store.modify(provider.id, async () => credential);
    return { provider: provider.id, method, verified };
  }
}

/**
 * The installation's identity, kept beside the credentials file it signs in to: created once, then read. Settled before
 * the flow runs, so a sign-in never completes with an identity that was not kept.
 */
async function deviceIdBeside(authPath: string): Promise<string> {
  const path = join(dirname(authPath), "device.json");
  try {
    return await readOrCreateDeviceId(path);
  } catch (error) {
    throw new Error(`could not persist login device ID in ${path}: ${(error as Error).message}`, { cause: error });
  }
}

async function readOrCreateDeviceId(path: string): Promise<string> {
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    const stored = (JSON.parse(text) as { deviceId?: unknown }).deviceId;
    if (typeof stored !== "string" || stored === "") throw new Error("it holds no deviceId");
    return stored;
  }
  const deviceId = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify({ deviceId })}\n`);
  return deviceId;
}

async function runFlow(
  flow: (interaction: AuthInteraction & { signal: AbortSignal }) => Promise<Credential>,
  interaction: AuthInteraction,
  signal: AbortSignal,
): Promise<Credential> {
  if (signal.aborted) throw new SignInCancelled("cancelled");
  const done = new AbortController();
  let backedOut: SignInCancelled | undefined;
  let credential: Credential;
  try {
    credential = await flow({
      signal,
      prompt: (prompt: AuthPrompt) => {
        const asked = anySignal(prompt.signal, signal, done.signal);
        return interaction.prompt({ ...prompt, signal: asked } as AuthPrompt).catch((error: unknown) => {
          // Remembered here: a provider may wrap the rejection it is handed in an error of its own. Only a question
          // still asked: one the flow withdrew (its callback came first) rejects too, and nobody backed out of it.
          if (error instanceof SignInCancelled && !asked?.aborted) backedOut = error;
          throw error;
        });
      },
      notify: (event: AuthEvent) => interaction.notify(event),
    });
  } catch (error) {
    // Whatever the provider made of the abort (its own error, a rejected prompt), it was the caller's decision.
    if (signal.aborted) throw new SignInCancelled("cancelled");
    if (backedOut !== undefined) throw backedOut;
    throw error;
  } finally {
    done.abort();
  }
  // A provider that ignored the abort and finished anyway: the caller still cancelled.
  if (signal.aborted) throw new SignInCancelled("cancelled");
  return credential;
}

/**
 * pi's default model per provider (`defaultModelPerProvider` in pi-coding-agent's model-resolver): the general-purpose
 * model pi itself starts on, so the likeliest to answer a minimal request. COPIED, because pi does not export it:
 * a pi upgrade that changes a default is not caught here.
 */
export const PI_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  "amazon-bedrock": "us.anthropic.claude-opus-5-5",
  "ant-ling": "Ring-2.6-1T",
  anthropic: "claude-opus-5-5",
  openai: "gpt-6.2-sol",
  azure: "gpt-6.2-sol",
  "openai-codex": "gpt-6.2-sol",
  radius: "balanced",
  nvidia: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  deepseek: "deepseek-v4-pro",
  google: "gemini-4-argon",
  "google-vertex": "gemini-4-argon",
  "github-copilot": "gpt-6.1-sol",
  openrouter: "moonshotai/kimi-k2.7-code",
  "vercel-ai-gateway": "zai/glm-5.3",
  xai: "grok-4.7",
  groq: "openai/gpt-oss-120b",
  cerebras: "gpt-oss-120b",
  zai: "glm-5.3",
  "zai-coding-cn": "glm-5.3",
  mistral: "mistral-medium-latest",
  minimax: "MiniMax-M3",
  "minimax-cn": "MiniMax-M3",
  moonshotai: "kimi-k2.7-code",
  "moonshotai-cn": "kimi-k2.7-code",
  huggingface: "moonshotai/Kimi-K2.7-Code",
  fireworks: "accounts/fireworks/models/kimi-k3",
  together: "moonshotai/Kimi-K3",
  baseten: "zai-org/GLM-5.3",
  opencode: "kimi-k2.7-code",
  "opencode-go": "kimi-k3.1-pro",
  "kimi-coding": "kimi-for-coding",
  meta: "muse-spark-1.3",
  "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.7-code",
  "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.7-code",
  "qwen-token-plan": "qwen3.8-max",
  "qwen-token-plan-cn": "qwen3.8-max",
  "qwen-token-plan-individual": "qwen3.8-max",
  "qwen-token-plan-individual-cn": "qwen3.8-max",
  xiaomi: "mimo-v2.6-pro",
  "xiaomi-token-plan-cn": "mimo-v2.6-pro",
  "xiaomi-token-plan-ams": "mimo-v2.6-pro",
  "xiaomi-token-plan-sgp": "mimo-v2.6-pro",
};

/** One minimal request with the key under test. */
async function verifyApiKey(
  models: Models,
  providerId: string,
  verifyWith: string | undefined,
  notify: (event: AuthEvent) => void,
  signal: AbortSignal,
): Promise<"ok" | "rejected" | "unknown"> {
  const chosen = verifyWith?.startsWith(`${providerId}/`)
    ? models.getModel(providerId, verifyWith.slice(providerId.length + 1))
    : undefined;
  const piDefault = PI_DEFAULT_MODELS[providerId];
  // The provider's first model is the last resort only: catalogs are alphabetical, and a first model can be a
  // special-purpose one that rejects a minimal request (which still answers the 401 question).
  const model =
    chosen ??
    (piDefault ? models.getModel(providerId, piDefault) : undefined) ??
    models.getProvider(providerId)?.getModels()[0];
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
