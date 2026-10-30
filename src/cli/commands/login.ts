/**
 * `fastagent login [provider]`: sign in to a model provider, into the project-level auth file
 * (`<agentDir>/.secrets/auth.json`) by default, or `FASTAGENT_AUTH_PATH`. In a terminal it asks, as pi's `/login`
 * does; otherwise (a script, a coding agent: no terminal, `--no-input` or `--json`) nothing is asked and nothing
 * waits: what it needs is named, and a person's step is handed back with a ticket to check (ticket.ts).
 * `--deployment` runs the same login on this agent's deployed box instead (box-login.ts); `--stdio` is the box's half.
 */
import type { AuthInteraction, AuthPrompt, Provider } from "@earendil-works/pi-ai";
import { enterAgentEnv, dotEnvPath } from "../../env.ts";
import {
  type FastagentCredentialStore,
  GLOBAL_AUTH_PATH,
  resolveAuthPath,
} from "../../harnesses/models/credentials.ts";
import { modelEnvironment } from "../../harnesses/models/environment.ts";
import { DEPLOY_HOSTS, type DeployHost } from "../../deploy/hosts.ts";
import { findAgentDir, globalHome, selectAgentEnvironment } from "../../paths.ts";
import {
  LoginCancelled,
  type LoginIO,
  type LoginMethod,
  type LoginOption,
  LoginRefused,
  PI_DEFAULT_MODELS,
  chooseLogin,
  loginFlow,
  loginOptionsOver,
  loginOver,
  loginStatusText,
} from "../../harnesses/models/login.ts";
import { environmentAuth, keyVariables, loginProviders } from "../../harnesses/models/models.ts";
import { definitionProviders, loadConfig, modelSpecFor } from "../../harnesses/pi-durable/open.ts";
import { loginOnBox, ticketLoginIO } from "../box-login.ts";
import { deploymentLoginCommand } from "../../deploy/box-shell.ts";
import { agentDirOrExit, failStartup, failUsage, optionalAgentDirOrExit } from "../fail.ts";
import {
  printReport,
  refusedCheck,
  type Ticket,
  type TicketStep,
  checkTicket,
  runTicket,
  startTicket,
  ticketExitCode,
  ticketReport,
} from "../ticket.ts";
import { type RelayResult, stdioLoginIO } from "../login-relay.ts";
import { isInteractive, terminalLoginIO } from "../shared.ts";
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
  /** `--timeout <seconds>`: how long the sign-in stays open. */
  timeout?: string;
  /** `--check <ticket>`: where a sign-in started without a terminal stands. */
  check?: string;
  /** `--code <address>` (with `--check`): the address the person's browser ended on, or the code it showed. */
  code?: string;
  /** `--ticket <id>`: the process that runs a ticket's sign-in. */
  ticket?: string;
  /** `--deployment <host>`: log in this agent's deployment on that host. */
  deployment?: string;
  /** `--stdio`: the box's half of `--deployment` — the flow speaks the relay wire on stdin/stdout. */
  stdio?: boolean;
  /** `--if-missing` (with `--stdio`): keep a credential already stored for the provider. */
  ifMissing?: boolean;
}

/** The command that reads a sign-in's ticket, as every such ticket records it. */
const LOGIN_CHECK = "fastagent login --check";

/** Without a terminal, how long a sign-in stays open for the person to finish it. */
const UNATTENDED_TIMEOUT_SECONDS = 600;

export async function runLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  if (opts.stdio) return runStdioLogin(provider, opts);
  if (opts.deployment !== undefined) return runDeploymentLogin(provider, opts);
  if (opts.check !== undefined) return runCheck(opts.check, opts);
  if (opts.code !== undefined) failUsage("--code hands an address to a sign-in: pass --check <ticket> too");
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
  const providersOf = () => (ownAgent ? definitionProviders(ownAgent) : Promise.resolve([]));
  if (opts.ticket !== undefined) {
    // The process `startTicket` started: it takes the ticket before loading the definition, then signs in.
    await runTicket(opts.ticket, async (step) => {
      const providers = await providersOf();
      const interaction = signInInteraction(step, provider as string);
      await loginOver({ provider: provider as string, method: "oauth", authPath, interaction }, { providers });
      const model = ownAgent ? await defaultModelHint(ownAgent, provider as string) : undefined;
      const name = loginProviders(providers).find((p) => p.id === provider)?.name ?? provider;
      return { provider, path: authPath, ...(model === undefined ? {} : { model, name }) };
    });
    process.exit(0);
  }
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
    ? ((await modelEnvironment(ownAgent, {}, providers)).credentials as FastagentCredentialStore)
    : authPath;
  if (opts.input === false || opts.json === true || !isInteractive()) {
    const offered = await loginOptionsOver(statusFrom, providers);
    return requestLogin(offered, { provider, method }, opts, {
      authPath,
      providers,
      valueFile: ownAgent === undefined ? undefined : dotEnvPath(ownAgent),
      heldIn: async (id) => (typeof statusFrom === "string" ? statusFrom : statusFrom.layerOf(id)),
      timeoutSeconds: givenTimeout ?? UNATTENDED_TIMEOUT_SECONDS,
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
    if (error instanceof LoginCancelled) {
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
function methodOf(value: string): LoginMethod {
  if (value === "account") return "oauth";
  if (value === "api-key") return "api_key";
  return failUsage(`--method must be account or api-key, not "${value}"`);
}

const methodWord = (method: LoginMethod) => (method === "oauth" ? "account" : "api-key");

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
  const config = await loadConfig(agentDir).catch(failStartup);
  if (modelSpecFor(config, undefined) !== undefined) return undefined;
  const modelId = PI_DEFAULT_MODELS[provider];
  return modelId === undefined ? undefined : `${provider}/${modelId}`;
}

/**
 * Login with no one at a terminal to ask, as Netlify's `login --request` and Dosu's tickets have it: a choice not
 * given is named with a command for each way (`need_choice`, exit 2); an account sign-in starts in a process of its
 * own and returns its address with a ticket (`need_user_action`, exit 0); an API key is the person's to set where the
 * agent reads it, never handed through the agent (`need_user_action` naming the variables).
 */
async function requestLogin(
  offered: readonly LoginOption[],
  given: { provider?: string | undefined; method?: LoginMethod | undefined },
  opts: LoginOptions,
  target: {
    authPath: string;
    providers: readonly Provider[];
    valueFile?: string;
    /** The credentials file that holds what `provider` has stored, as the agent reads it. */
    heldIn: (provider: string) => Promise<string>;
    timeoutSeconds: number;
  },
): Promise<void> {
  const global = opts.global ? " -g" : "";
  let choice: LoginOption;
  try {
    choice = await chooseLogin(offered, given, undefined);
  } catch (error) {
    if (!(error instanceof LoginRefused)) throw error;
    return choiceNotGiven(error, opts, { flags: global, statuses: true });
  }
  if (choice.method === "api_key") return keyNeeded(choice, opts, target);
  const ticket = await startTicket({
    subject: `login:${choice.provider}`,
    action: `sign in to ${choice.name}`,
    check: LOGIN_CHECK,
    restart: `fastagent login ${choice.provider} --method account${global}`,
    timeoutSeconds: target.timeoutSeconds,
    waitsFirst: true,
    whenRunning: "replace",
    command: {
      file: process.execPath,
      args: [
        ...process.execArgv,
        process.argv[1] as string,
        "login",
        choice.provider,
        "--method",
        "account",
        ...(opts.global ? ["-g"] : []),
      ],
      cwd: process.cwd(),
    },
  });
  // No browser is opened: the agent hands the address to its person, who may be on another machine.
  reportTicket(ticket, opts, "started");
  process.exit(ticketExitCode(ticket));
}

/**
 * An API key with no terminal to type it in: the variables the person sets themselves where the agent reads them, and
 * how to tell it worked. With no agent's value file to name (`-g`, or no agent here), the person signs in at a terminal
 * of their own, which keeps the key in the global file `auth check -g` reads: the agent's environment was fixed when it
 * started, so a variable set now would never reach it.
 */
async function keyNeeded(
  choice: LoginOption,
  opts: LoginOptions,
  target: { providers: readonly Provider[]; valueFile?: string; heldIn: (provider: string) => Promise<string> },
): Promise<void> {
  const base = { provider: choice.provider, method: "api-key" };
  if (choice.status?.type === "api_key") {
    printReport(opts.json, { status: "ready", ...base, source: choice.status.source }, [
      `ready: ${choice.name} is authenticated by ${choice.status.source}`,
    ]);
    return;
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
    return;
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
  choice: LoginOption,
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

/** `login --check <ticket> [--code <address>]`. */
async function runCheck(id: string, opts: LoginOptions): Promise<void> {
  const refused = refusedCheck(id, LOGIN_CHECK);
  if (refused !== undefined) failUsage(refused);
  // There: refusedCheck read it, and a ticket is pruned only a day after it ends.
  const ticket = (await checkTicket(id, opts.code)) as Ticket;
  reportTicket(ticket, opts, "checked");
  process.exit(ticketExitCode(ticket));
}

/** A sign-in's ticket for whoever started or checked it: the shared report, and what a finished sign-in adds. */
function reportTicket(ticket: Ticket, opts: LoginOptions, when: "started" | "checked"): void {
  // `login:<provider>`, or `login:<provider>@<host>` for a deployment's.
  const [provider, deployment] = ticket.subject.slice("login:".length).split("@") as [string, string | undefined];
  const { json, text } = ticketReport(ticket, when, (result) => {
    if (deployment !== undefined) {
      return { fields: {}, text: [`signed in on the ${deployment} deployment`], next: "Signed in on the deployment." };
    }
    const hint = typeof result.model === "string" ? modelHint(result.model, String(result.name)) : undefined;
    return {
      fields: { path: result.path, ...(result.model ? { model: result.model } : {}) },
      text: [`saved to ${String(result.path)}`, ...(hint === undefined ? [] : [hint])],
      next: hint === undefined ? "Signed in." : `Signed in. Tell the user: ${hint}.`,
    };
  });
  const about = { provider, method: "account", ...(deployment === undefined ? {} : { deployment }) };
  printReport(opts.json, { ...json, ...about }, text);
}

/**
 * pi-ai's account sign-in, run by a ticket's process with no one to answer it. A choice takes its first option, pi's
 * default (the browser sign-in); a text question is left blank, the one pi-ai's account sign-ins ask being Copilot's
 * optional Enterprise domain (a required one fails in the provider's own flow, which the ticket reports); a secret it
 * cannot take; the code or address a browser ends on comes from `login --check --code`, unless the provider's callback
 * brings it first. Not public: a test seam.
 */
export function signInInteraction(step: TicketStep, provider: string): AuthInteraction {
  return {
    signal: step.signal,
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      if (prompt.type === "select") return (prompt.options[0] as { id: string }).id;
      if (prompt.type === "text") return "";
      if (prompt.type === "secret") {
        throw new Error(
          `the sign-in asks "${prompt.message}", which only a terminal can answer: run \`fastagent login ${provider}\` ` +
            "in one",
        );
      }
      return step.address(prompt.signal ? AbortSignal.any([prompt.signal, step.signal]) : step.signal);
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        step.waits({
          url: event.url,
          takesAddress: true,
          ...(event.instructions ? { instructions: event.instructions } : {}),
        });
      } else if (event.type === "device_code") {
        step.waits({ url: event.verificationUri, code: event.userCode });
      }
      console.error(`[fastagent] ${event.type}: ${"message" in event ? event.message : ""}`);
    },
  };
}

/**
 * `--deployment <host>`: always named. The agent directory cannot answer which host it means: a Railway deploy leaves
 * no file of its own there, and a directory can hold several hosts' files, so a guess could log a different box in
 * than the one that asked. Every command fastagent prints names it (`deploymentLoginCommand`, `deployedHost`).
 */
async function runDeploymentLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  if (opts.global) failUsage("--deployment logs the deployment in; -g names this machine's global file — pick one");
  const agentDir = agentDirOrExit(process.cwd());
  selectAgentEnvironment("production");
  enterAgentEnv(agentDir);
  if (!(DEPLOY_HOSTS as readonly string[]).includes(opts.deployment as string)) {
    failUsage(
      `--deployment takes a host (${DEPLOY_HOSTS.join(", ")}), not "${opts.deployment}" — to name a provider too: ` +
        `fastagent login <provider> --deployment <host>`,
    );
  }
  const host = opts.deployment as DeployHost;
  const method = opts.method === undefined ? undefined : methodOf(opts.method);
  if (opts.ticket !== undefined) {
    // The process `startTicket` started: it holds the box's shell while the person signs in.
    const retry = deploymentLoginCommand(host, provider);
    await runTicket(opts.ticket, async (step) => {
      const io = ticketLoginIO(step, retry);
      const failed = await loginOnBox({
        host,
        shell: await HOSTS[host].shell(agentDir),
        provider: provider as string,
        method: "oauth",
        input: true,
        io,
      });
      if (failed) throw new Error(io.refusal() ?? failed);
      return { provider, deployment: host };
    });
    process.exit(0);
  }
  if (opts.input === false || opts.json === true || !isInteractive()) {
    const timeout = opts.timeout === undefined ? UNATTENDED_TIMEOUT_SECONDS : secondsOf(opts.timeout);
    return requestDeploymentLogin(agentDir, host, { provider, method }, opts, timeout);
  }
  const failed = await loginOnBox({
    host,
    shell: await HOSTS[host].shell(agentDir).catch(failStartup),
    ...(provider ? { provider } : {}),
    ...(method ? { method } : {}),
    input: true,
  });
  if (failed) failStartup(new Error(failed));
  process.exit(0);
}

/**
 * `login --deployment <host>` with no one at a terminal. The sign-in is chosen here, from the definition the box
 * serves; what this machine holds says nothing of the box, so no status is shown. An account sign-in runs on the box
 * through a ticket whose process holds the box's shell (box-login.ts `ticketLoginIO`). An API key reaches a box only
 * as a variable its deploy carries, so the person sets it in the production value file and the agent deploys again.
 */
async function requestDeploymentLogin(
  agentDir: string,
  host: DeployHost,
  given: { provider?: string | undefined; method?: LoginMethod | undefined },
  opts: LoginOptions,
  timeoutSeconds: number,
): Promise<void> {
  const providers = await definitionProviders(agentDir).catch(failStartup);
  const offered = await loginOptionsOver(resolveAuthPath(agentDir), providers);
  let choice: LoginOption;
  try {
    choice = await chooseLogin(offered, given, undefined);
  } catch (error) {
    if (!(error instanceof LoginRefused)) throw error;
    return choiceNotGiven(error, opts, { flags: ` --deployment ${host}`, statuses: false });
  }
  if (choice.method === "api_key") {
    const valueFile = dotEnvPath(agentDir);
    const { variables, what } = await keyToSet(choice, providers);
    const deploy = `fastagent deploy ${host} --run`;
    printReport(
      opts.json,
      {
        status: "need_user_action",
        provider: choice.provider,
        method: "api-key",
        deployment: host,
        variables,
        value_file: valueFile,
        check_command: deploy,
        agent_next_steps:
          `Ask the user to set ${what} in ${valueFile} themselves, not in this conversation. A key reaches the ` +
          `${host} deployment with its next deploy: once they say they have, run check_command.`,
      },
      [
        `need_user_action: set ${what} in ${valueFile}`,
        `then run: ${deploy}   # the key reaches the deployment with its deploy`,
      ],
    );
    process.exit(0);
  }
  const ticket = await startTicket({
    subject: `login:${choice.provider}@${host}`,
    action: `sign in to ${choice.name} for the ${host} deployment`,
    check: LOGIN_CHECK,
    restart: `fastagent login ${choice.provider} --method account --deployment ${host}`,
    timeoutSeconds,
    // Reaching the box comes first, and can take a while (a host's shell, an idle runtime woken).
    waitsFirst: false,
    whenRunning: "replace",
    command: {
      file: process.execPath,
      args: [
        ...process.execArgv,
        process.argv[1] as string,
        "login",
        choice.provider,
        "--method",
        "account",
        "--deployment",
        host,
      ],
      cwd: process.cwd(),
    },
  });
  reportTicket(ticket, opts, "started");
  process.exit(ticketExitCode(ticket));
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
      error instanceof LoginCancelled
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
  // proxy they name. AgentCore's command shell hands down none of the runtime's, so a proxy carried there in
  // FASTAGENT_ENV does not reach the login (docs/deploy.md).
  enterAgentEnv(agentDir);
  // The model environment the serving Agent reads (openServing), its definition's providers included, so "logged in"
  // means what the server will use, and a provider only the definition declares can be signed in to.
  const providers = await definitionProviders(agentDir);
  const models = await modelEnvironment(agentDir, {}, providers);
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
