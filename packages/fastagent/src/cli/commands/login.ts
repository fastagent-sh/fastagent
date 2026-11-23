/**
 * `fastagent login [provider]`: sign in to a model provider locally (`<agentDir>/.secrets/auth.json`), globally (`-g`,
 * `~/.fastagent/.secrets/auth.json`), or on a remote instance (`--url` / `--remote`, stored in durable instance
 * storage). Interactive in a terminal; non-interactive runs (`--no-input`, `--json`, or no TTY) never block and
 * return structured `need_choice`/`need_user_action` (exit 2).
 */
import { definedValues } from "../../declared-secrets.ts";
import type { Provider } from "@earendil-works/pi-ai";
import { enterAgentEnv } from "../../env.ts";
import { readProcessEnv } from "../../process-env.ts";
import { dotEnvPath } from "../../value-file.ts";
import {
  type FastagentCredentialStore,
  GLOBAL_AUTH_PATH,
  resolveAuthPath,
} from "../../harnesses/models/credentials.ts";
import { modelEnvironment } from "../../harnesses/models/environment.ts";
import { globalHome } from "../../paths.ts";
import {
  LoginRefused,
  PI_DEFAULT_MODELS,
  SignInCancelled,
  type SignInMethod,
  type SignInOption,
  loginOptionsOver,
} from "../../harnesses/models/login.ts";
import { environmentAuth, keyVariables, loginProviders } from "../../harnesses/models/models.ts";
import { definitionProviders, loadSourceDefinition, modelSpecFor } from "../../harnesses/assembly.ts";
import type { RemoteTargetFlags } from "../deployment.ts";
import { failStartup, failUsage, optionalAgentDirOrExit } from "../fail.ts";
import type { InstanceFlags } from "../instance.ts";
import { chooseLogin, isInteractive, loginFlow, printReport, reportNeedChoice, terminalLoginIO } from "../login-ui.ts";
import { resolveRemoteAuthTarget, runRemoteLogin } from "../remote-login.ts";

export interface LoginOptions extends RemoteTargetFlags {
  /** `-g`: store in the user-global file, which an agent reads for a provider it has no other credential for. */
  global?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  /** `--method account|api-key`: how to sign in, for a provider that offers both. */
  method?: string;
  /** `--json`: the outcome as one JSON object on stdout. */
  json?: boolean;
  /** `--timeout <seconds>`: how long an interactive sign-in stays open. */
  timeout?: string;
  instance?: InstanceFlags;
}

export async function runLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  const method = opts.method === undefined ? undefined : methodOf(opts.method);
  const givenTimeout = opts.timeout === undefined ? undefined : secondsOf(opts.timeout);
  const remoteTarget = await resolveRemoteAuthTarget(opts);
  if (remoteTarget !== undefined) {
    await runRemoteLogin(remoteTarget.auth, remoteTarget.label, provider, {
      ...(method === undefined ? {} : { method }),
      ...(opts.input === undefined ? {} : { input: opts.input }),
      ...(opts.json === undefined ? {} : { json: opts.json }),
      ...(givenTimeout === undefined ? {} : { timeoutSeconds: givenTimeout }),
      ...(opts.url === undefined ? {} : { url: opts.url }),
      ...(opts.remote === undefined ? {} : { remote: opts.remote }),
    });
    return;
  }
  // "Outside an agent" must mean exactly that: inside one is refused (findAgentDir), never a global login.
  const agentDir = optionalAgentDirOrExit(process.cwd());
  // Outside any agent the target is the user-global machinery home — handed over explicitly, so the path resolvers
  // need no "is this $HOME?" special case to infer it.
  const loginDir = agentDir ?? globalHome();
  // A proxy may be configured in the project .env, and the OAuth token exchange must go through it (region-locked
  // providers).
  // Before the agent's `.env` joins it: the shadowing check below is about what EVERY agent sees, and that is the
  // environment the shell hands down, not one agent's value file.
  const shellEnv = readProcessEnv();
  enterAgentEnv(loginDir);
  // `-g` names the global file outright. Otherwise the agent's own file — the one owner. The
  // store built here is deliberately UNLAYERED: reading falls back to the global file, but writing must land
  // exactly where the operator said, or a second `login` for a provider they already have globally would silently
  // rewrite the global credential instead of creating the project-level override they asked for.
  const authPath = opts.global ? GLOBAL_AUTH_PATH : resolveAuthPath(loginDir);
  const ownAgent = opts.global ? undefined : agentDir;
  // The definition's providers too: a gateway's key is verified against the gateway, not a built-in's endpoint. Not for
  // `-g`: the global file serves every agent on this machine, so no one agent's providers decide what it holds.
  const providersOf = () => (ownAgent ? definitionProviders(ownAgent, readProcessEnv()) : Promise.resolve([]));
  const providers = await providersOf().catch(failStartup);
  // Announce when the FALLBACK is what decided the target: outside an agent with no explicit path, the credential
  // lands somewhere no agent will read.
  if (!agentDir && !opts.global) {
    console.error(
      `[fastagent] no agent here (no fastagent.config.ts) — ` +
        `logging in GLOBALLY (${authPath}). An agent on this machine uses this file for a provider it has no ` +
        `credential of its own for (no entry in its .secrets/auth.json, no env variable), so this is usually what ` +
        `you want; \`cd\` into an agent to give that one its own account instead.`,
    );
  }
  // What the agent reads, its file over the global one, is what authenticates each provider for it now.
  const statusFrom = ownAgent
    ? ((await modelEnvironment(ownAgent, {}, providers, { environment: definedValues(readProcessEnv()) }))
        .credentials as FastagentCredentialStore)
    : authPath;
  if (opts.input === false || opts.json === true || !isInteractive()) {
    const offered = await loginOptionsOver(statusFrom, providers);
    return requestLogin(offered, { provider, method }, opts, {
      providers,
      valueFile: ownAgent === undefined ? undefined : dotEnvPath(ownAgent),
      heldIn: async (id) => (typeof statusFrom === "string" ? statusFrom : statusFrom.layerOf(id)),
    });
  }
  const timeout = givenTimeout === undefined ? undefined : AbortSignal.timeout(givenTimeout * 1000);
  // An entered API key is verified with one minimal request (login.ts); a rejected one is asked for again.
  const result = await loginFlow(terminalLoginIO(), {
    authPath,
    providers,
    statusFrom: typeof statusFrom === "string" ? undefined : statusFrom,
    ...(provider ? { provider } : {}),
    ...(method ? { method } : {}),
    ...(timeout ? { signal: timeout } : {}),
  }).catch((error: unknown): never => {
    if (timeout?.aborted) failStartup(new Error(`login timed out after ${givenTimeout}s (--timeout)`));
    if (error instanceof SignInCancelled) {
      // A decision, not a failure — neutral wording; non-zero exit because no credential was stored.
      console.error(`[fastagent] login cancelled`);
      process.exit(1);
    }
    if (error instanceof LoginRefused) failUsage(error.message);
    failStartup(error);
  });
  const name = loginProviders(providers).find((p) => p.id === result.provider)?.name ?? result.provider;
  console.error(
    result.method === "oauth"
      ? `[fastagent] logged in to ${name} — saved to ${authPath}`
      : `[fastagent] saved the API key for ${name} to ${authPath}`,
  );
  const model = ownAgent ? await defaultModelHint(ownAgent, result.provider) : undefined;
  if (model !== undefined) console.error(`[fastagent] ${modelHint(model, name)}`);
  // The environment outranks the global file for every agent, so a global login it shadows would sit unused while
  // agents run on, say, an API key billed per request, with only a startup line to show it.
  const shadowedBy =
    authPath === GLOBAL_AUTH_PATH ? (await environmentAuth(result.provider, shellEnv))?.source : undefined;
  if (shadowedBy !== undefined) {
    console.error(
      `[fastagent] warning: ${result.provider} is also authenticated by ${shadowedBy} in your shell environment, which ` +
        `agents use before the global file, so this login is not used while it is set. Unset it to use this login.`,
    );
  }
  process.exit(0); // the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
}

const modelHint = (model: string, name: string) =>
  `this agent has no model: \`model: "${model}"\` in fastagent.config.ts uses ${name}'s default`;

/** `--method`'s words, pi's: an account (OAuth) or an API key. */
function methodOf(value: string): SignInMethod {
  if (value === "account") return "oauth";
  if (value === "api-key") return "api_key";
  return failUsage(`--method must be account or api-key, not "${value}"`);
}

function secondsOf(value: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0)
    failUsage(`--timeout must be a whole number of seconds, not "${value}"`);
  return seconds;
}

/**
 * pi's default model for `provider`, when the agent in `agentDir` has no model of its own: what pi starts on after a
 * sign-in. Printed, never written: the model belongs in the author's own config.
 */
async function defaultModelHint(agentDir: string, provider: string): Promise<string | undefined> {
  const { config } = await loadSourceDefinition(agentDir).catch(failStartup);
  if (modelSpecFor(config, undefined) !== undefined) return undefined;
  const modelId = PI_DEFAULT_MODELS[provider];
  return modelId === undefined ? undefined : `${provider}/${modelId}`;
}

/**
 * Login with no terminal: a choice not given returns `need_choice` (exit 2); an API key names the env variable or
 * interactive command; an account OAuth sign-in returns `need_user_action` (exit 2) with the terminal command.
 */
async function requestLogin(
  offered: readonly SignInOption[],
  given: { provider?: string | undefined; method?: SignInMethod | undefined },
  opts: LoginOptions,
  target: {
    providers: readonly Provider[];
    valueFile?: string;
    /** The credentials file that holds what `provider` has stored, as the agent reads it. */
    heldIn: (provider: string) => Promise<string>;
  },
): Promise<never> {
  const global = opts.global ? " -g" : "";
  let choice: SignInOption;
  try {
    choice = await chooseLogin(offered, given, undefined);
  } catch (error) {
    if (!(error instanceof LoginRefused)) throw error;
    return reportNeedChoice(error, opts, { flags: global, statuses: true });
  }
  if (choice.method === "api_key") return keyNeeded(choice, opts, target);
  const terminal = `fastagent login ${choice.provider} --method account${global}`;
  const check = `fastagent login ${choice.provider} --check${opts.global ? " -g" : ""}`;
  printReport(
    opts.json,
    {
      status: "need_user_action",
      provider: choice.provider,
      method: "account",
      terminal_command: terminal,
      check_command: `${check} --json`,
      agent_next_steps:
        "Ask the user to run terminal_command in a terminal of their own to complete the browser OAuth flow, then run check_command.",
    },
    [`need_user_action: run in an interactive terminal: ${terminal}`, `then run: ${check}`],
  );
  process.exit(2);
}

/**
 * An API key with no terminal to type it in: the variables the person sets themselves where the agent reads them, and
 * how to tell it worked.
 */
async function keyNeeded(
  choice: SignInOption,
  opts: LoginOptions,
  target: { providers: readonly Provider[]; valueFile?: string; heldIn: (provider: string) => Promise<string> },
): Promise<never> {
  const base = { provider: choice.provider, method: "api-key" };
  if (choice.status?.type === "api_key") {
    printReport(opts.json, { status: "ready", ...base, source: choice.status.source }, [
      `ready: ${choice.name} is authenticated by ${choice.status.source}`,
    ]);
    process.exit(0);
  }
  const check = `fastagent login ${choice.provider} --check${target.valueFile === undefined ? " -g" : ""}`;
  if (target.valueFile === undefined) {
    const terminal = `fastagent login ${choice.provider} --method api-key -g`;
    printReport(
      opts.json,
      {
        status: "need_user_action",
        ...base,
        terminal_command: terminal,
        check_command: `${check} --json`,
        agent_next_steps:
          "Ask the user to run terminal_command in a terminal of their own: it asks for the key there, not in this " +
          "conversation, and keeps it in the global credentials file. Once they say they have, run check_command.",
      },
      [`need_user_action: run in a terminal of your own: ${terminal}`, `then run: ${check}`],
    );
    process.exit(2);
  }
  // A stored account sign-in outranks any key in the environment: it goes first, or the key set now is never used.
  const outranking = choice.status?.source === "OAuth" ? await target.heldIn(choice.provider) : undefined;
  const logout =
    outranking === undefined
      ? undefined
      : `fastagent logout ${choice.provider}${outranking === GLOBAL_AUTH_PATH ? " -g" : ""}`;
  const { variables, what } = await keyToSet(choice, target.providers);
  const first =
    logout === undefined
      ? ""
      : `${choice.name} is signed in with an account in ${outranking}, which outranks a key in the environment: ` +
        "run logout_command first (with the user's agreement: it removes that sign-in). Then ";
  printReport(
    opts.json,
    {
      status: "need_user_action",
      ...base,
      variables,
      value_file: target.valueFile,
      ...(logout === undefined ? {} : { logout_command: logout }),
      check_command: `${check} --json`,
      agent_next_steps:
        `${first}${first ? "ask" : "Ask"} the user to set ${what} in ${target.valueFile} themselves, not in this ` +
        "conversation. Once they say they have, run check_command.",
    },
    [
      ...(logout === undefined ? [] : [`first, to replace the account sign-in in ${outranking}: ${logout}`]),
      `need_user_action: set ${what} in ${target.valueFile}`,
      `then run: ${check}`,
    ],
  );
  process.exit(2);
}

/** The variables `choice`'s key is read from, and how to tell the person to set it. */
async function keyToSet(
  choice: SignInOption,
  providers: readonly Provider[],
): Promise<{ variables: string[]; what: string }> {
  const provider = loginProviders(providers).find((p) => p.id === choice.provider);
  const variables = provider ? await keyVariables(provider) : [];
  const what =
    variables.length === 0
      ? `its key as ${choice.name}'s own documentation says`
      : variables.length === 1
        ? `${variables[0]}=<their ${choice.name} key>`
        : `the variables ${choice.name} reads its key from (${variables.join(", ")})`;
  return { variables, what };
}
