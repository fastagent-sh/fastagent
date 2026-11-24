/**
 * Terminal interaction and menu selection for `fastagent login` / `logout` / first-run sign-in.
 * Keeps CLI flag wording (`--method`) and `@clack/prompts` out of `harnesses/models/login.ts`.
 */
import { autocomplete, isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import type { AuthEvent, AuthInteraction, AuthPrompt, CredentialStore, Provider } from "@earendil-works/pi-ai";
import {
  LoginRefused,
  SignInCancelled,
  type SignInMethod,
  type SignInOption,
  type SignInResult,
  loginOptionsOver,
  loginOver,
  loginStatusText,
} from "../harnesses/models/login.ts";
import { openExternalUrl } from "../open-url.ts";
import { failStartup, failUsage } from "./fail.ts";

const ACCOUNT_LABEL = "Sign in with an account";
const API_KEY_LABEL = "Sign in with an API key";
const METHOD_FLAGS = "--method account or --method api-key";

/** CLI spelling for a sign-in method: `--method account` or `--method api-key`. */
export const methodWord = (method: SignInMethod): "account" | "api-key" => (method === "oauth" ? "account" : "api-key");

/** Both stdin and stdout are a terminal — the precondition for an interactive prompt. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Print one JSON object or human-readable lines to stdout. */
export function printReport(asJson: boolean | undefined, json: Record<string, unknown>, text: readonly string[]): void {
  if (asJson) {
    console.log(JSON.stringify(json));
    return;
  }
  for (const line of text) console.log(line);
}

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

/** Login terminal IO via `@clack/prompts`: a searchable list once long, a hidden prompt for keys. */
export function terminalLoginIO(): LoginIO {
  return {
    async select(message, options) {
      const r = await (options.length > 7 ? autocomplete : select)({ message, options });
      return isCancel(r) ? undefined : (r as string);
    },
    async prompt(message, opts) {
      const signalOpt = opts?.signal === undefined ? {} : { signal: opts.signal };
      const r = opts?.hidden ? await password({ message, ...signalOpt }) : await clackText({ message, ...signalOpt });
      return isCancel(r) ? undefined : (r as string);
    },
    note: (message) => clackLog.info(message),
    openUrl: openExternalUrl,
  };
}

export function presentAuthUrl(io: LoginIO, url: string, instructions?: string): void {
  io.note(`Open this URL to authorize:\n  ${url}`);
  if (instructions) io.note(instructions);
  io.openUrl(url);
}

export function presentDeviceCode(io: LoginIO, verificationUri: string, userCode: string): void {
  io.note(`Go to ${verificationUri} and enter the code:  ${userCode}`);
  io.openUrl(verificationUri, userCode);
}

export function promptAuthInput(
  io: LoginIO,
  prompt: {
    readonly type: "text" | "secret" | "manual_code" | "select";
    readonly message: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly description?: string }>;
  },
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (prompt.type === "select") {
    return io.select(
      prompt.message,
      (prompt.options ?? []).map((o) => ({
        value: o.id,
        label: o.label,
        ...(o.description ? { hint: o.description } : {}),
      })),
    );
  }
  return io.prompt(prompt.message, {
    hidden: prompt.type === "secret",
    redirect: prompt.type === "manual_code",
    ...(signal ? { signal } : {}),
  });
}

/** {@link LoginIO} as pi-ai's `AuthInteraction`: what {@link loginOver} drives for the terminal. */
function terminalInteraction(io: LoginIO, signal: AbortSignal | undefined): AuthInteraction {
  return {
    ...(signal ? { signal } : {}),
    prompt: async (p: AuthPrompt): Promise<string> => {
      const v = await promptAuthInput(io, p, p.signal);
      if (v === undefined) throw new SignInCancelled("cancelled");
      return v;
    },
    notify: (e: AuthEvent): void => {
      if (e.type === "auth_url") presentAuthUrl(io, e.url, e.instructions);
      else if (e.type === "device_code") presentDeviceCode(io, e.verificationUri, e.userCode);
      else io.note(e.message);
    },
  };
}

/**
 * Report a missing non-interactive login choice (exit 2), used by both local and remote `fastagent login`.
 */
export function reportNeedChoice(
  error: LoginRefused,
  opts: { json?: boolean },
  how: { flags: string; statuses: boolean },
): never {
  if (opts.json) {
    const choices = error.choices.map((o) => ({
      provider: o.provider,
      name: o.name,
      method: methodWord(o.method),
      label: o.label,
      ...(how.statuses ? { status: loginStatusText(o) } : {}),
      command: `fastagent login ${o.provider} --method ${methodWord(o.method)}${how.flags} --json`,
    }));
    printReport(
      true,
      {
        status: "need_choice",
        message: error.message,
        choices,
        agent_next_steps: "Ask the user which of these to sign in with, then run that choice's command.",
      },
      [],
    );
  }
  return failUsage(error.message);
}

export interface StoredLogoutEntry {
  readonly id: string;
  readonly name: string;
  readonly type: SignInMethod;
}

/**
 * Shared 4-branch logout flow for local credential files and remote Auth API targets.
 */
export async function logoutFlow(
  target: {
    readonly where: string;
    readonly stored: readonly StoredLogoutEntry[];
    readonly selectMessage: string;
    readonly delete: (providerId: string) => Promise<boolean>;
    readonly removedMessage: (chosen: StoredLogoutEntry) => string;
  },
  givenProvider: string | undefined,
  opts: { input?: boolean },
  io: LoginIO = terminalLoginIO(),
): Promise<void> {
  const { stored, where } = target;
  const held = stored.length === 0 ? "it holds none" : `it holds ${stored.map(({ id }) => id).join(", ")}`;

  let chosen: StoredLogoutEntry | undefined;
  if (givenProvider !== undefined) {
    const named = givenProvider.trim().toLowerCase();
    chosen = stored.find(({ id, name }) => id.toLowerCase() === named || name.toLowerCase() === named);
    if (chosen === undefined) {
      failStartup(new Error(`no credential for "${givenProvider}" is stored ${where}: ${held}`));
    }
  } else if (stored.length === 0) {
    console.error(`[fastagent] no credential is stored ${where}; environment variables are not login's to remove`);
    return;
  } else if (opts.input === false || !isInteractive()) {
    failUsage(`name the provider to log out of: ${held} (${where})`);
  } else {
    const value = await io.select(
      target.selectMessage,
      stored.map(({ id, name, type }) => ({ value: id, label: name, hint: type === "oauth" ? "account" : "API key" })),
    );
    chosen = stored.find(({ id }) => id === value);
    if (chosen === undefined) {
      console.error("[fastagent] logout cancelled");
      process.exit(1);
    }
  }
  const removed = await target.delete(chosen.id);
  if (!removed) failStartup(new Error(`no credential for "${chosen.id}" is stored ${where}`));
  console.error(target.removedMessage(chosen));
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
    /** Model spec to verify an entered key against. */
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
