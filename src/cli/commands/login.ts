/**
 * `fastagent login [provider]`: authenticate a model provider into the project-level auth file
 * (`<agentDir>/.secrets/auth.json`) by default, or `FASTAGENT_AUTH_PATH`. `--deployment` runs the same login on this
 * workspace's deployed box instead (box-login.ts); `--stdio` is the box's half of that.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { resolveAuthPath } from "../../engines/pi/config.ts";
import { GLOBAL_AUTH_PATH, fastagentCredentialStore } from "../../engines/pi/auth.ts";
import { DEPLOY_HOSTS, type DeployHost } from "../../deploy/hosts.ts";
import { GLOBAL_HOME_DIR, findAgentDir, placementDeadEnd } from "../../paths.ts";
import { LoginCancelled, type LoginIO, type LoginMethod, loginFlow } from "../../engines/pi/login.ts";
import { createPiModelRuntime, environmentAuthSource, probeAuthSource } from "../../engines/pi/models.ts";
import { loginOnBox } from "../box-login.ts";
import { failStartup, failUsage, placementOrExit } from "../fail.ts";
import { type RelayResult, stdioLoginIO } from "../login-relay.ts";
import { isInteractive, terminalLoginIO } from "../shared.ts";
import { HOSTS } from "./deploy.ts";

export interface LoginOptions {
  /** `-g`: store in the user-global file, which an agent reads for a provider it has no other credential for. */
  global?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  /** `--deployment [host]`: log in this workspace's deployment (`true` when no host was named). */
  deployment?: string | boolean;
  /** `--stdio`: the box's half of `--deployment` — the flow speaks the relay wire on stdin/stdout. */
  stdio?: boolean;
  /** `--if-missing` (with `--stdio`): keep a credential already stored for the provider. */
  ifMissing?: boolean;
}

export async function runLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  if (opts.stdio) return runStdioLogin(provider, opts);
  if (opts.deployment !== undefined) return runDeploymentLogin(provider, opts);
  const cwd = process.cwd();
  const agentDir = findAgentDir(cwd);
  // "Outside an agent" must mean exactly that.
  if (!agentDir && placementDeadEnd(cwd)) placementOrExit(cwd);
  // Outside any agent the target is the user-global machinery home — handed over explicitly, so the path resolvers
  // need no "is this $HOME?" special case to infer it.
  const loginDir = agentDir ?? join(homedir(), GLOBAL_HOME_DIR);
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
      `[fastagent] no agent here (no fastagent.config.ts, here or one level inside) — ` +
        `logging in GLOBALLY (${authPath}). An agent on this machine uses this file for a provider it has no ` +
        `credential of its own for (no entry in its .secrets/auth.json, no apiKey in its models.json, no env ` +
        `variable), so this is usually what you want; \`cd\` into an agent to give that one its own account instead.`,
    );
  }
  // login is inherently interactive — loginFlow renders provider/method menus and opens a browser (or prompts for a
  // key).
  if (opts.input === false || !isInteractive()) {
    failStartup(
      new Error(`login is interactive (it shows a menu and opens a browser) — run it in a terminal, not a pipe/CI`),
    );
  }
  // An entered API key is verified with one minimal request (login.ts); a rejected one is asked for again.
  // Inside an agent, the key is checked on that agent's registry: its models.json may point a provider at a gateway.
  // Not with `-g`: the global file serves every agent on the machine, so no one agent's routing may judge its key.
  const result = await loginFlow(terminalLoginIO(), {
    authPath,
    ...(provider ? { provider } : {}),
    ...(agentDir && !opts.global ? { agentDir } : {}),
  }).catch((error: unknown) => {
    if (error instanceof LoginCancelled) {
      // A decision, not a failure — neutral wording; non-zero exit because no credential was stored.
      console.error(`[fastagent] login cancelled`);
      process.exit(1);
    }
    failStartup(error);
  });
  console.error(`[fastagent] logged in to ${result.provider} (${result.method}) — saved to ${authPath}`);
  // The environment outranks the global file for every agent, so a global login it shadows would sit unused while
  // agents run on, say, an API key billed per request, with only a startup line to show it.
  const shadowedBy = authPath === GLOBAL_AUTH_PATH ? await environmentAuthSource(result.provider, shellEnv) : undefined;
  if (shadowedBy !== undefined) {
    console.error(
      `[fastagent] warning: ${result.provider} is also authenticated by ${shadowedBy} in your shell environment, which ` +
        `agents use before the global file, so this login is not used while it is set. Unset it to use this login.`,
    );
  }
  process.exit(0); // the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
}

/**
 * `--deployment [host]`: the host is named, or the one whose generated artifact is in the agent dir. Several is a
 * question only the operator can answer, so it is asked back rather than guessed.
 */
async function runDeploymentLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  if (opts.global) failUsage("--deployment logs the deployment in; -g names this machine's global file — pick one");
  const placement = placementOrExit(process.cwd());
  // The host's CLI must reach the account/region/proxy the deploy used, and those may be definition-local.
  enterAgentEnv(placement.agentDir);
  let host: DeployHost;
  if (typeof opts.deployment === "string") {
    if (!(DEPLOY_HOSTS as readonly string[]).includes(opts.deployment)) {
      failUsage(
        `--deployment takes a host (${DEPLOY_HOSTS.join(", ")}), not "${opts.deployment}" — to name a provider too: ` +
          `fastagent login <provider> --deployment <host>`,
      );
    }
    host = opts.deployment as DeployHost;
  } else {
    const found = DEPLOY_HOSTS.filter((h) => existsSync(join(placement.agentDir, HOSTS[h].artifact)));
    if (found.length !== 1) {
      failUsage(
        found.length === 0
          ? `no deployment artifacts in ${placement.agentDir} — name the host: --deployment <${DEPLOY_HOSTS.join("|")}>`
          : `this agent deploys to ${found.join(" and ")} — name one: --deployment <${found.join("|")}>`,
      );
    }
    host = found[0] as DeployHost;
  }
  const input = opts.input !== false && isInteractive();
  if (!input) {
    failStartup(new Error(`login is interactive (it shows a menu and opens a browser) — run it in a terminal`));
  }
  const failed = await loginOnBox({
    host,
    shell: await HOSTS[host].shell(placement).catch(failStartup),
    placement,
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
  const agentDir = findAgentDir(process.cwd());
  if (agentDir) enterAgentEnv(agentDir); // the server's egress proxy, if its value file declares one
  const authPath = resolveAuthPath(agentDir ?? process.cwd());
  if (opts.ifMissing && provider) {
    const held = await heldCredential(authPath, provider, agentDir);
    if (held.source !== undefined) return { ok: true, provider, kept: held.source };
    if (opts.input === false) {
      const what = held.stored
        ? `the stored ${provider} ${held.stored} credential is expired or unusable`
        : `no ${provider} credential`;
      return { ok: false, reason: "missing", message: `${what} in ${authPath}` };
    }
  }
  if (opts.input === false) {
    return { ok: false, reason: "missing", message: `no ${provider ?? "model"} credential in ${authPath}` };
  }
  const result = await loginFlow(io, {
    authPath,
    ...(provider ? { provider } : {}),
    ...(agentDir ? { agentDir } : {}),
  });
  return { ok: true, provider: result.provider, method: result.method, path: authPath };
}

/**
 * Whether the box has a credential for `provider` that is not expired, or refreshed when it was, and from where: the
 * same answer its own startup report gives (`probeAuthSource`). `source` decides; `stored` (what auth.json holds) only
 * words the refusal. The file alone would not do: an OAuth grant whose refresh the provider refuses is still a line in
 * it, and a key the host sets as a platform variable is no line at all.
 *
 * Known ceiling: nothing is asked of the provider beyond a due refresh, so a revoked grant whose access token has not
 * expired yet, or a revoked API key, reads as held; the first turn then fails with the provider's own error. Asking
 * would spend a real model call on every redeploy, which the readiness checks deliberately never do.
 */
export async function heldCredential(
  authPath: string,
  provider: string,
  agentDir: string | undefined,
): Promise<{ source?: string; stored?: LoginMethod }> {
  const stored = (await fastagentCredentialStore(authPath).list()).find((info) => info.providerId === provider)?.type;
  const models = await createPiModelRuntime({ ...(agentDir ? { agentDir } : {}), auth: { path: authPath } });
  const model = models.getProvider(provider)?.getModels()[0];
  const source = model ? await probeAuthSource(models, `${provider}/${model.id}`) : undefined;
  return { ...(source !== undefined ? { source } : {}), ...(stored !== undefined ? { stored } : {}) };
}
