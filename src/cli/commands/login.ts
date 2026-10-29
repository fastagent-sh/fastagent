/**
 * `fastagent login [provider]`: authenticate a model provider into the project-level auth file
 * (`<agentDir>/.secrets/auth.json`) by default, or `FASTAGENT_AUTH_PATH`. `--deployment` runs the same login on this
 * agent's deployed box instead (box-login.ts); `--stdio` is the box's half of that.
 */
import { enterAgentEnv } from "../../env.ts";
import { GLOBAL_AUTH_PATH, resolveAuthPath } from "../../harnesses/models/credentials.ts";
import { modelEnvironment } from "../../harnesses/models/environment.ts";
import { DEPLOY_HOSTS, type DeployHost } from "../../deploy/hosts.ts";
import { findAgentDir, globalHome, selectAgentEnvironment } from "../../paths.ts";
import {
  LoginCancelled,
  type LoginIO,
  type LoginMethod,
  LoginRefused,
  PI_DEFAULT_MODELS,
  loginFlow,
} from "../../harnesses/models/login.ts";
import { environmentAuth, loginProviders } from "../../harnesses/models/models.ts";
import { definitionProviders, loadConfig, modelSpecFor } from "../../harnesses/pi-durable/open.ts";
import { loginOnBox } from "../box-login.ts";
import { agentDirOrExit, failStartup, failUsage, optionalAgentDirOrExit } from "../fail.ts";
import { type RelayResult, stdioLoginIO } from "../login-relay.ts";
import { openExternalUrl } from "../../open-url.ts";
import { LoginNeedsAnswer, scriptedLoginIO } from "../scripted-login.ts";
import { isInteractive, terminalLoginIO } from "../shared.ts";
import { HOSTS } from "./deploy.ts";

export interface LoginOptions {
  /** `-g`: store in the user-global file, which an agent reads for a provider it has no other credential for. */
  global?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  /** `--method account|api-key`: how to sign in, for a provider that offers both. */
  method?: string;
  /** `--json`: what the sign-in says, and how it ended, as JSON lines on stdout. */
  json?: boolean;
  /** `--timeout <seconds>`: how long the whole sign-in may take. */
  timeout?: string;
  /** `--deployment <host>`: log in this agent's deployment on that host. */
  deployment?: string;
  /** `--stdio`: the box's half of `--deployment` — the flow speaks the relay wire on stdin/stdout. */
  stdio?: boolean;
  /** `--if-missing` (with `--stdio`): keep a credential already stored for the provider. */
  ifMissing?: boolean;
}

/** Without a terminal, a sign-in waiting on a browser or stdin gives up after this long. */
const UNATTENDED_TIMEOUT_SECONDS = 300;

/** How a login run ends, as `--json` prints it last; its exit code follows from `reason`. */
type LoginEnd =
  | { ok: true; provider: string; method: LoginMethod; path: string; model?: string }
  | { ok: false; reason: "cancelled" | "refused" | "failed"; message: string };

export async function runLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  if (opts.stdio) return runStdioLogin(provider, opts);
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
  const menus = opts.input !== false && opts.json !== true && isInteractive();
  const timeoutSeconds = givenTimeout ?? (menus ? undefined : UNATTENDED_TIMEOUT_SECONDS);
  const timeout = timeoutSeconds === undefined ? undefined : AbortSignal.timeout(timeoutSeconds * 1000);
  const end = (outcome: LoginEnd): void => {
    if (opts.json) console.log(JSON.stringify({ type: "result", ...outcome }));
  };
  const io = menus
    ? terminalLoginIO()
    : scriptedLoginIO(process.stdin, (notice) => {
        if (opts.json) console.log(JSON.stringify(notice));
        else console.error(`[fastagent] ${notice.type === "note" ? notice.message : `opening ${notice.url}`}`);
        // A person signs in in the browser, which may well be on this machine.
        if (notice.type === "open") openExternalUrl(notice.url);
      });
  // The definition's providers too: a gateway's key is verified against the gateway, not a built-in's endpoint. Not for
  // `-g`: the global file serves every agent on this machine, so no one agent's providers decide what it holds.
  const providers = agentDir && !opts.global ? await definitionProviders(agentDir).catch(failStartup) : [];
  // What the agent reads, its file over the global one, is what authenticates each provider for it now.
  const agentReads =
    agentDir && !opts.global ? (await modelEnvironment(agentDir, {}, providers)).credentials : undefined;
  // An entered API key is verified with one minimal request (login.ts); a rejected one is asked for again.
  const result = await loginFlow(io, {
    authPath,
    providers,
    menus,
    ...(agentReads ? { statusFrom: agentReads } : {}),
    ...(provider ? { provider } : {}),
    ...(method ? { method } : {}),
    ...(timeout ? { signal: timeout } : {}),
  }).catch((error: unknown): never => {
    const message = (error as Error).message;
    if (timeout?.aborted) {
      const timedOut = `login timed out after ${timeoutSeconds}s (--timeout)`;
      end({ ok: false, reason: "failed", message: timedOut });
      failStartup(new Error(timedOut));
    }
    if (error instanceof LoginCancelled) {
      // A decision, not a failure — neutral wording; non-zero exit because no credential was stored.
      end({ ok: false, reason: "cancelled", message: "login cancelled" });
      console.error(`[fastagent] login cancelled`);
      process.exit(1);
    }
    if (error instanceof LoginRefused || error instanceof LoginNeedsAnswer) {
      end({ ok: false, reason: "refused", message });
      failUsage(message);
    }
    end({ ok: false, reason: "failed", message });
    failStartup(new Error(message));
  });
  const name = loginProviders(providers).find((p) => p.id === result.provider)?.name ?? result.provider;
  const model = agentDir && !opts.global ? await defaultModelHint(agentDir, result.provider) : undefined;
  end({ ok: true, provider: result.provider, method: result.method, path: authPath, ...(model ? { model } : {}) });
  console.error(
    result.method === "oauth"
      ? `[fastagent] logged in to ${name} — saved to ${authPath}`
      : `[fastagent] saved the API key for ${name} to ${authPath}`,
  );
  if (model !== undefined) {
    console.error(
      `[fastagent] this agent has no model: \`model: "${model}"\` in fastagent.config.ts uses ${name}'s default`,
    );
  }
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

/** `--method`'s words, pi's: an account (OAuth) or an API key. */
function methodOf(value: string): LoginMethod {
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
  const config = await loadConfig(agentDir).catch(failStartup);
  if (modelSpecFor(config, undefined) !== undefined) return undefined;
  const modelId = PI_DEFAULT_MODELS[provider];
  return modelId === undefined ? undefined : `${provider}/${modelId}`;
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
  const input = opts.input !== false && isInteractive();
  if (!input) {
    failStartup(new Error(`login is interactive (it shows a menu and opens a browser) — run it in a terminal`));
  }
  const failed = await loginOnBox({
    host,
    shell: await HOSTS[host].shell(agentDir).catch(failStartup),
    ...(provider ? { provider } : {}),
    input,
  });
  if (failed) failStartup(new Error(failed));
  process.exit(0);
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
  const result = await loginFlow(io, { authPath: auth.path, providers, ...(provider ? { provider } : {}) });
  return { ok: true, provider: result.provider, method: result.method, path: auth.path };
}
