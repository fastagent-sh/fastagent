/**
 * Signing in to a MODEL PROVIDER, for any front end: {@link loginOver} runs one provider's flow over pi-ai's own
 * `AuthInteraction` and persists the credential through the same {@link fastagentCredentialStore} the runtime reads
 * (one writer, one lock/corruption semantics); {@link loginOptionsOver} is the list a picker offers. An embedding host
 * reaches both through host.ts (`signIn`, `signInOptions`); `fastagent login` is a front end of its own
 * ({@link loginFlow}: terminal menus, then {@link loginOver}); `login --deployment` drives the same flow on a deployed
 * box over a relay (cli/login-relay.ts).
 */
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
import { SignInCancelled, type SignInMethod, type SignInOption, type SignInResult } from "../../sign-in-api.ts";
import { assertOneCredentialSource, fastagentCredentialStore } from "./credentials.ts";
import { UNNAMED_AUTH_SOURCE, interactiveAuth, loginProviders, modelsOver, probeApiKey } from "./models.ts";

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
  // The environment alone, over no store: what authenticates a provider nothing is stored for.
  const environment = modelsOver(new InMemoryCredentialStore(), providers);
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
  /**
   * Stable installation identity (Sign in with ChatGPT requires one). With `authPath` it defaults to `device.json`
   * beside that file, written before the flow runs; over a caller's `credentialStore` there is no file to keep it
   * beside, so a flow that needs one fails unless this supplies it.
   */
  getDeviceId?: () => string;
  provider: string;
  method: SignInMethod;
  /** pi-ai's own interaction: prompts (`text`, `secret`, `select`, `manual_code`) and events (`auth_url`, …). */
  interaction: AuthInteraction;
} & (
  | {
      /** The credentials file the sign-in is written to. */
      authPath: string;
      credentialStore?: never;
    }
  | {
      /** The caller's own store the sign-in is written to, in place of any file. */
      credentialStore: CredentialStore;
      authPath?: never;
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
  const { providers, verifyWith } = internals;
  const { method, interaction } = request;
  assertOneCredentialSource(request);
  if (request.credentialStore === undefined && typeof request.authPath !== "string") {
    throw new Error("login needs authPath or credentialStore: where the sign-in is written");
  }
  const provider = loginProviders(providers).find((p) => p.id === request.provider);
  if (!provider) throw new Error(`unknown provider "${request.provider}"`);
  const auth = interactiveAuth(provider, method);
  if (!auth?.login) throw new Error(`provider "${provider.id}" has no interactive ${method} login`);
  const flow = auth.login.bind(auth);
  // The key under test lives here, not in the file, until it passes.
  const trial = new InMemoryCredentialStore();
  // Only a key needs the registry: it is checked with one request before it is kept.
  const models: Models | undefined = method === "api_key" ? modelsOver(trial, providers) : undefined;
  const store = request.credentialStore ?? fastagentCredentialStore(request.authPath);
  await store.modify(provider.id, async () => undefined);
  const signal = interaction.signal ?? new AbortController().signal;
  const notify = (event: AuthEvent) => interaction.notify(event);
  let getDeviceId = request.getDeviceId;
  if (method === "oauth" && !getDeviceId && request.authPath !== undefined) {
    const deviceId = await deviceIdBeside(request.authPath);
    getDeviceId = () => deviceId;
  }

  for (;;) {
    const credential = await runFlow((io) => flow(io, { getDeviceId }), interaction, signal);
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
 * model pi itself starts on, so the likeliest to answer a minimal request. COPIED, because pi does not export it;
 * `test/login.test.ts` compares this against pi's own table, so a pi release that changes a default fails there.
 */
export const PI_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
  "ant-ling": "Ring-2.6-1T",
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.5",
  azure: "gpt-5.4",
  "openai-codex": "gpt-6.1-sol",
  radius: "balanced",
  nvidia: "nvidia/nemotron-3-ultra-550b-a55b",
  deepseek: "deepseek-v4-pro",
  google: "gemini-3.1-pro-preview",
  "google-vertex": "gemini-3.1-pro-preview",
  "github-copilot": "gpt-5.4",
  openrouter: "moonshotai/kimi-k2.6",
  "vercel-ai-gateway": "zai/glm-5.1",
  xai: "grok-4.7",
  groq: "openai/gpt-oss-120b",
  cerebras: "gpt-oss-120b",
  zai: "glm-5.3",
  "zai-coding-cn": "glm-5.3",
  mistral: "devstral-medium-latest",
  minimax: "MiniMax-M2.7",
  "minimax-cn": "MiniMax-M2.7",
  moonshotai: "kimi-k2.6",
  "moonshotai-cn": "kimi-k2.6",
  huggingface: "moonshotai/Kimi-K2.6",
  fireworks: "accounts/fireworks/models/kimi-k3",
  together: "moonshotai/Kimi-K3",
  baseten: "zai-org/GLM-5.2",
  opencode: "kimi-k2.6",
  "opencode-go": "kimi-k3",
  "kimi-coding": "kimi-for-coding",
  meta: "muse-spark-1.3",
  "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
  "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
  "qwen-token-plan": "qwen3.7-max",
  "qwen-token-plan-cn": "qwen3.7-max",
  "qwen-token-plan-individual": "qwen3.8-max",
  xiaomi: "mimo-v2.5-pro",
  "xiaomi-token-plan-cn": "mimo-v2.5-pro",
  "xiaomi-token-plan-ams": "mimo-v2.5-pro",
  "xiaomi-token-plan-sgp": "mimo-v2.5-pro",
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
  /**
   * Free-text or hidden input. `redirect`: what is asked is the address the browser ended on after signing in, or the
   * code its page showed (pi-ai's `manual_code`).
   */
  prompt(
    message: string,
    opts?: { hidden?: boolean; redirect?: boolean; signal?: AbortSignal },
  ): Promise<string | undefined>;
  /** Print an informational line (auth URL, device code, progress). */
  note(message: string): void;
  /** Best-effort open a URL in the browser (printed regardless); `userCode` is what a device sign-in enters there. */
  openUrl(url: string, userCode?: string): void;
}

/** {@link LoginIO} as pi-ai's `AuthInteraction`: what {@link loginOver} drives for the terminal. */
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
          : await io.prompt(p.message, {
              hidden: p.type === "secret",
              redirect: p.type === "manual_code",
              ...(p.signal ? { signal: p.signal } : {}),
            });
      if (v === undefined) throw new SignInCancelled("cancelled");
      return v;
    },
    notify: (e: AuthEvent): void => {
      if (e.type === "auth_url") {
        io.note(`Open this URL to authorize:\n  ${e.url}`);
        if (e.instructions) io.note(e.instructions);
        io.openUrl(e.url);
      } else if (e.type === "device_code") {
        io.note(`Go to ${e.verificationUri} and enter the code:  ${e.userCode}`);
        io.openUrl(e.verificationUri, e.userCode);
      } else {
        io.note(e.message);
      }
    },
  };
}

/**
 * `fastagent login` in a terminal: ask only what was not given, as pi's `/login` asks it (how to sign in, then the
 * provider; a provider named by its id or its name, then how, when it offers both), then {@link loginOver}.
 */
export async function loginFlow(
  io: LoginIO,
  options: {
    authPath: string;
    provider?: string;
    method?: SignInMethod;
    providers?: readonly Provider[];
    signal?: AbortSignal;
    /**
     * Where the menus read what authenticates each provider now: the credentials the agent reads (its file over the
     * global one), which can hold more than the file a sign-in writes. Default that file.
     */
    statusFrom?: CredentialStore;
    /** {@link LoginInternals.verifyWith}. */
    verifyWith?: string;
  },
): Promise<SignInResult> {
  const offered = await loginOptionsOver(options.statusFrom ?? options.authPath, options.providers);
  const choice = await chooseLogin(offered, options, io);
  if (choice.external) {
    throw new LoginRefused(`${choice.name} is configured outside fastagent: set its key in the environment`, []);
  }
  return loginOver(
    {
      provider: choice.provider,
      method: choice.method,
      authPath: options.authPath,
      interaction: terminalInteraction(io, options.signal),
    },
    {
      ...(options.providers ? { providers: options.providers } : {}),
      ...(options.verifyWith ? { verifyWith: options.verifyWith } : {}),
    },
  );
}

/** The flag that gives a method, as a refusal names it. */
const METHOD_FLAGS = "--method account or --method api-key";

/**
 * The sign-in `given` names, or, with `menus`, the one a person picks; without them a choice not given refuses
 * ({@link LoginRefused}) naming how to give it.
 */
export async function chooseLogin(
  offered: readonly SignInOption[],
  given: { provider?: string; method?: SignInMethod },
  menus: LoginIO | undefined,
): Promise<SignInOption> {
  const picked = async (
    message: string,
    options: IoOption[],
    from: readonly SignInOption[],
    by: (o: SignInOption) => string,
  ) => {
    const value = await (menus as LoginIO).select(message, options);
    const option = from.find((o) => by(o) === value);
    if (option === undefined) throw new SignInCancelled("nothing selected");
    return option;
  };
  if (given.provider !== undefined) {
    const named = given.provider.trim().toLowerCase();
    const ofProvider = offered.filter((o) => o.provider.toLowerCase() === named || o.name.toLowerCase() === named);
    if (ofProvider.length === 0) {
      throw new LoginRefused(`unknown provider "${given.provider}": ${providerIds(offered)}`, offered);
    }
    const name = (ofProvider[0] as SignInOption).name;
    const ofMethod = given.method === undefined ? ofProvider : ofProvider.filter((o) => o.method === given.method);
    if (ofMethod.length === 0) {
      const only = (ofProvider[0] as SignInOption).method === "oauth" ? "an account" : "an API key";
      throw new LoginRefused(`${name} signs in only with ${only}`, ofProvider);
    }
    if (ofMethod.length === 1) return ofMethod[0] as SignInOption;
    if (menus === undefined)
      throw new LoginRefused(`${name} signs in with an account or an API key: pass ${METHOD_FLAGS}`, ofMethod);
    return picked(
      `Select authentication method for ${name}:`,
      ofMethod.map((o) => ({ value: o.method, label: o.label })),
      ofMethod,
      (o) => o.method,
    );
  }
  if (menus === undefined) {
    throw new LoginRefused(
      `name the provider to sign in to (${providerIds(offered)}), and ${METHOD_FLAGS} for one that offers both`,
      given.method === undefined ? offered : offered.filter((o) => o.method === given.method),
    );
  }
  let method = given.method;
  if (method === undefined) {
    // pi offers its own gateway beside the two ways of signing in.
    const radius = offered.find((o) => o.provider === "radius" && o.method === "oauth");
    const ways: IoOption[] = [
      ...(offered.some((o) => o.method === "oauth") ? [{ value: "oauth", label: ACCOUNT_LABEL }] : []),
      ...(offered.some((o) => o.method === "api_key") ? [{ value: "api_key", label: API_KEY_LABEL }] : []),
      ...(radius ? [{ value: "radius", label: `Sign in with ${radius.name}${statusSuffix(radius)}` }] : []),
    ];
    const way = await menus.select("Select authentication method:", ways);
    if (way === "radius" && radius) return radius;
    if (way !== "oauth" && way !== "api_key") throw new SignInCancelled("no authentication method selected");
    method = way;
  }
  const candidates = offered.filter((o) => o.method === method);
  if (candidates.length === 0)
    throw new LoginRefused(`no provider signs in with ${method === "oauth" ? "an account" : "an API key"}`, []);
  return picked(
    "Select provider to configure:",
    candidates.map((o) => ({ value: o.provider, label: `${o.name}${statusSuffix(o)}` })),
    candidates,
    (o) => o.provider,
  );
}

/** An option's status after its name on every row, as pi's picker writes it: ` ✓ configured`, ` • not configured`. */
function statusSuffix(option: SignInOption): string {
  const text = loginStatusText(option);
  return text.startsWith("✓") ? ` ${text}` : ` • ${text}`;
}

/** Every provider id a sign-in can name, for a refusal that must say which. */
function providerIds(offered: readonly SignInOption[]): string {
  return `one of ${[...new Set(offered.map((o) => o.provider))].sort().join(", ")}`;
}
