/**
 * `fastagent login [provider]`: sign in to a model provider, into the project-level auth file
 * (`<agentDir>/.secrets/auth.json`) by default, or `FASTAGENT_AUTH_PATH`. In a terminal it asks, as pi's `/login`
 * does; otherwise (a script, a coding agent: no terminal, `--no-input` or `--json`) nothing is asked and nothing
 * blocks: missing choices or interactive auth return structured `need_choice`/`need_user_action` (exit 2).
 * `--deployment` runs the same login on this agent's deployed box instead (box-login.ts); `--stdio` is the box's half.
 */
import { definedValues } from "../../declared-secrets.ts";
import type { Provider } from "@earendil-works/pi-ai";
import { enterAgentEnv } from "../../env.ts";
import { dotEnvPath } from "../../value-file.ts";
import { enterDeploymentEnv } from "../instance.ts";
import {
  type FastagentCredentialStore,
  GLOBAL_AUTH_PATH,
  resolveAuthPath,
} from "../../harnesses/models/credentials.ts";
import { modelEnvironment } from "../../harnesses/models/environment.ts";
import { DEPLOY_HOSTS, type DeployHost } from "../../deploy/hosts.ts";
import { findAgentDir, globalHome, selectAgentEnvironment } from "../../paths.ts";
import { SignInCancelled, type SignInMethod, type SignInOption } from "../../sign-in-api.ts";
import {
  type LoginIO,
  LoginRefused,
  PI_DEFAULT_MODELS,
  chooseLogin,
  loginFlow,
  loginOptionsOver,
  loginStatusText,
} from "../../harnesses/models/login.ts";
import { environmentAuth, keyVariables, loginProviders } from "../../harnesses/models/models.ts";
import { resolveConfig } from "../../harnesses/pi-durable/config.ts";
import { definitionProviders, loadDevProject, modelSpecFor } from "../../harnesses/pi-durable/open.ts";
import { loginOnBox } from "../box-login.ts";
import { deploymentName } from "../../deploy/deployment-name.ts";
import { shellArg } from "../../shell-arg.ts";
import { agentDirOrExit, failStartup, failUsage, optionalAgentDirOrExit } from "../fail.ts";
import { type RelayResult, stdioLoginIO } from "../login-relay.ts";
import { isInteractive, printReport, terminalLoginIO } from "../shared.ts";
import { HOSTS } from "./deploy.ts";

export interface LoginOptions {
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
  /** `--deployment <host>`: log in this agent's deployment on that host. */
  deployment?: string;
  /** `--config <file>` (with `--deployment`): the configuration that names the instance to log in. */
  config?: string;
  /** `--env-file <file>` (with `--deployment`): the host account's variables, over this command's environment. */
  envFile?: string;
  /** `--stdio`: the box's half of `--deployment` — the flow speaks the relay wire on stdin/stdout. */
  stdio?: boolean;
  /** `--if-missing` (with `--stdio`): keep a credential already stored for the provider. */
  ifMissing?: boolean;
}

export async function runLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  if (opts.stdio) return runStdioLogin(provider, opts);
  if (opts.config !== undefined && opts.deployment === undefined) {
    failUsage("--config names the deployment that --deployment logs in: pass --deployment <host> too");
  }
  if (opts.envFile !== undefined && opts.deployment === undefined && !opts.stdio) {
    failUsage("--env-file here is the deployment's host account: pass --deployment <host> too");
  }
  if (opts.deployment !== undefined) return runDeploymentLogin(provider, opts);
  const method = opts.method === undefined ? undefined : methodOf(opts.method);
  const givenTimeout = opts.timeout === undefined ? undefined : secondsOf(opts.timeout);
  // "Outside an agent" must mean exactly that: inside one is refused (findAgentDir), never a global login.
  const agentDir = optionalAgentDirOrExit(process.cwd());
  // Outside any agent the target is the user-global machinery home — handed over explicitly, so the path resolvers
  // need no "is this $HOME?" special case to infer it.
  const loginDir = agentDir ?? globalHome();
  // FASTAGENT_AUTH_PATH and a proxy may both be configured in the project .env, and the OAuth token exchange must go
  // through that proxy (region-locked providers).
  // Before the agent's `.env` joins it: the shadowing check below is about what EVERY agent sees, and that is the
  // environment the shell hands down, not one agent's value file.
  const shellEnv = { ...process.env };
  enterAgentEnv(loginDir);
  // `-g` names the global file outright. Otherwise: FASTAGENT_AUTH_PATH > default — the one owner. The
  // store built here is deliberately UNLAYERED: reading falls back to the global file, but writing must land
  // exactly where the operator said, or a second `login` for a provider they already have globally would silently
  // rewrite the global credential instead of creating the project-level override they asked for.
  const authPath = opts.global ? GLOBAL_AUTH_PATH : resolveAuthPath(loginDir);
  const ownAgent = opts.global ? undefined : agentDir;
  // The definition's providers too: a gateway's key is verified against the gateway, not a built-in's endpoint. Not for
  // `-g`: the global file serves every agent on this machine, so no one agent's providers decide what it holds.
  const providersOf = () => (ownAgent ? definitionProviders(ownAgent, process.env) : Promise.resolve([]));
  const providers = await providersOf().catch(failStartup);
  // Announce when the FALLBACK is what decided the target: outside an agent with no explicit path, the credential
  // lands somewhere no agent will read.
  if (!agentDir && !opts.global && !process.env.FASTAGENT_AUTH_PATH) {
    console.error(
      `[fastagent] no agent here (no fastagent.config.ts) — ` +
        `logging in GLOBALLY (${authPath}). An agent on this machine uses this file for a provider it has no ` +
        `credential of its own for (no entry in its .secrets/auth.json, no env variable), so this is usually what ` +
        `you want; \`cd\` into an agent to give that one its own account instead.`,
    );
  }
  // What the agent reads, its file over the global one, is what authenticates each provider for it now.
  const statusFrom = ownAgent
    ? ((await modelEnvironment(ownAgent, {}, providers, { environment: definedValues(process.env) }))
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
  `this agent has no model: \`defaults: { model: "${model}" }\` in fastagent.config.ts uses ${name}'s default`;

/** `--method`'s words, pi's: an account (OAuth) or an API key. */
function methodOf(value: string): SignInMethod {
  if (value === "account") return "oauth";
  if (value === "api-key") return "api_key";
  return failUsage(`--method must be account or api-key, not "${value}"`);
}

const methodWord = (method: SignInMethod) => (method === "oauth" ? "account" : "api-key");

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
  const config = await loadDevProject(agentDir)
    .then(({ definition, instance }) => resolveConfig(definition, instance))
    .catch(failStartup);
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
    return choiceNotGiven(error, opts, { flags: global, statuses: true });
  }
  if (choice.method === "api_key") return keyNeeded(choice, opts, target);
  const terminal = `fastagent login ${choice.provider} --method account${global}`;
  const check = `fastagent auth check --provider ${choice.provider}${opts.global ? " -g" : ""}`;
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
  const check = `fastagent auth check --provider ${choice.provider}${target.valueFile === undefined ? " -g" : ""}`;
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

/**
 * A sign-in not chosen with no one to ask (exit 2): with `--json`, the choices and the command for each, `flags`
 * added to it. `statuses`: what authenticates each provider here is worth showing (it is not, for a deployment).
 */
function choiceNotGiven(error: LoginRefused, opts: LoginOptions, how: { flags: string; statuses: boolean }): never {
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

/** ` --config <file>` for a command that names this instance again, or nothing. */
const configArg = ({ config, envFile }: LoginOptions): string =>
  `${config === undefined ? "" : ` --config ${shellArg(config)}`}${envFile === undefined ? "" : ` --env-file ${shellArg(envFile)}`}`;

/** `--deployment <host>`: always named. */
async function runDeploymentLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  if (opts.global) failUsage("--deployment logs the deployment in; -g names this machine's global file — pick one");
  const agentDir = agentDirOrExit(process.cwd());
  selectAgentEnvironment("production");
  // A deployment has no default value file: only the environment this command runs in.
  enterDeploymentEnv(agentDir, opts.envFile);
  if (!(DEPLOY_HOSTS as readonly string[]).includes(opts.deployment as string)) {
    failUsage(
      `--deployment takes a host (${DEPLOY_HOSTS.join(", ")}), not "${opts.deployment}" — to name a provider too: ` +
        `fastagent login <provider> --deployment <host>`,
    );
  }
  const host = opts.deployment as DeployHost;
  const method = opts.method === undefined ? undefined : methodOf(opts.method);
  if (opts.input === false || opts.json === true || !isInteractive()) {
    return requestDeploymentLogin(agentDir, host, { provider, method }, opts);
  }
  const name = await deploymentName(agentDir, opts.config).catch(failStartup);
  const failed = await loginOnBox({
    host,
    shell: await HOSTS[host].shell(agentDir, name).catch(failStartup),
    ...(opts.config === undefined ? {} : { configFile: opts.config }),
    ...(opts.envFile === undefined ? {} : { envFile: opts.envFile }),
    ...(provider ? { provider } : {}),
    ...(method ? { method } : {}),
    input: true,
  });
  if (failed) failStartup(new Error(failed));
  process.exit(0);
}

/**
 * `login --deployment <host>` without a terminal: never blocks or spawns a daemon; returns `need_choice` or
 * `need_user_action` (exit 2) naming the terminal command or secret setter.
 */
async function requestDeploymentLogin(
  agentDir: string,
  host: DeployHost,
  given: { provider?: string | undefined; method?: SignInMethod | undefined },
  opts: LoginOptions,
): Promise<never> {
  const providers = await definitionProviders(agentDir, process.env).catch(failStartup);
  const offered = await loginOptionsOver(resolveAuthPath(agentDir), providers);
  let choice: SignInOption;
  try {
    choice = await chooseLogin(offered, given, undefined);
  } catch (error) {
    if (!(error instanceof LoginRefused)) throw error;
    return choiceNotGiven(error, opts, {
      flags: ` --deployment ${host}${configArg(opts)}`,
      statuses: false,
    });
  }
  if (choice.method === "api_key") {
    const { variables, what } = await keyToSet(choice, providers);
    const deploy = `fastagent deploy ${host}${configArg(opts)} --run`;
    const setKey =
      host === "docker" ? undefined : `fastagent secrets set ${host} ${variables[0] ?? "<KEY_NAME>"}${configArg(opts)}`;
    const how =
      setKey === undefined
        ? `export ${variables.join(" or ")} in the environment that runs Compose (it takes the value from there)`
        : `run set_command in a terminal, which asks for ${what} without echo`;
    printReport(
      opts.json,
      {
        status: "need_user_action",
        provider: choice.provider,
        method: "api-key",
        deployment: host,
        variables,
        ...(setKey === undefined ? {} : { set_command: setKey }),
        check_command: deploy,
        agent_next_steps: `Ask the user to ${how}, themselves: not in this conversation. Once they say they have, run check_command.`,
      },
      [
        `need_user_action: set ${what} on ${host}`,
        setKey === undefined ? how : `run: ${setKey}   # typed in a terminal`,
        `then run: ${deploy}`,
      ],
    );
    process.exit(2);
  }
  const terminal = `fastagent login ${choice.provider} --method account --deployment ${host}${configArg(opts)}`;
  printReport(
    opts.json,
    {
      status: "need_user_action",
      provider: choice.provider,
      method: "account",
      deployment: host,
      terminal_command: terminal,
      agent_next_steps:
        "Ask the user to run terminal_command in a terminal of their own to sign in on the deployed box.",
    },
    [`need_user_action: run in an interactive terminal: ${terminal}`],
  );
  process.exit(2);
}

/**
 * `--stdio`: the box's half of `--deployment`. Runs where the server runs; everything it would show or ask travels as
 * the relay wire, and it ends with exactly one result line. Never started by hand: the credential path is the one the
 * caller exported (container.ts `boxLoginCommand`).
 */
async function runStdioLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  const wire = stdioLoginIO(process.stdin, process.stdout);
  const result = await stdioLogin(wire.io, provider, opts).catch(
    (error: unknown): RelayResult =>
      error instanceof SignInCancelled
        ? { ok: false, reason: "cancelled", message: "cancelled" }
        : { ok: false, reason: "failed", message: (error as Error).message },
  );
  wire.result(result);
  process.exitCode = result.ok ? 0 : 1;
  // Exit once the result line is flushed: an undici keep-alive socket would otherwise hold the process open.
  process.stdout.write("", () => process.exit());
}

async function stdioLogin(io: LoginIO, provider: string | undefined, opts: LoginOptions): Promise<RelayResult> {
  // `boxLoginCommand` starts this in the deployed agent directory; anywhere else there is no box to log in.
  const agentDir = findAgentDir(process.cwd());
  if (!agentDir) throw new Error(`login --stdio: ${process.cwd()} is not an agent directory`);
  // A deployed box has no value file to read: its variables reach this process only as the host's shell hands them
  // down (the container's for `docker compose exec`, the platform's over fly/railway ssh), and this installs the egress
  // proxy they name. AgentCore's command shell hands down none of the runtime's, so a proxy the runtime has
  // in its values does not reach the login (docs/deploy.md).
  enterAgentEnv(agentDir);
  // The model environment the serving Agent reads (openServing), its definition's providers included, so "logged in"
  // means what the server will use, and a provider only the definition declares can be signed in to.
  const providers = await definitionProviders(agentDir, process.env);
  const models = await modelEnvironment(agentDir, {}, providers, { environment: definedValues(process.env) });
  const auth = models.auth as NonNullable<typeof models.auth>;
  if (opts.ifMissing && provider) {
    // The server's own answer (`authStatus`), the one its startup report prints. Known ceiling: nothing is asked of
    // the provider beyond a due refresh, so a revoked grant whose access token has not expired yet, or a revoked API
    // key, reads as held and the first turn fails with the provider's error. Asking would spend a real model call on
    // every redeploy, which the readiness checks deliberately never do.
    const held = await models.authStatus(provider);
    if (held.source !== undefined) return { ok: true, provider, kept: held.source };
    if (opts.input === false) {
      const what = held.stored
        ? `the stored ${provider} ${held.stored} credential is expired or unusable`
        : `no ${provider} credential`;
      const because = held.error === undefined ? "" : ` (${held.error})`;
      return { ok: false, reason: "missing", message: `${what}${because} in ${held.path ?? auth.path}` };
    }
  }
  if (opts.input === false) {
    return { ok: false, reason: "missing", message: `no ${provider ?? "model"} credential in ${auth.path}` };
  }
  const method = opts.method === undefined ? undefined : methodOf(opts.method);
  const result = await loginFlow(io, {
    authPath: auth.path,
    providers,
    ...(provider ? { provider } : {}),
    ...(method ? { method } : {}),
  });
  return { ok: true, provider: result.provider, method: result.method, path: auth.path };
}
