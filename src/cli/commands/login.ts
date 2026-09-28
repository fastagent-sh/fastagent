/**
 * `fastagent login [provider]`: authenticate a model provider into the project-level auth file
 * (`<agentDir>/.secrets/auth.json`) by default, or `FASTAGENT_AUTH_PATH`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { enterAgentEnv } from "../../env.ts";
import { resolveAuthPath } from "../../engines/pi/config.ts";
import { GLOBAL_AUTH_PATH } from "../../engines/pi/auth.ts";
import { GLOBAL_HOME_DIR, findAgentDir, placementDeadEnd } from "../../paths.ts";
import { LoginCancelled, loginFlow } from "../../engines/pi/login.ts";
import { environmentAuthSource } from "../../engines/pi/models.ts";
import { failStartup, placementOrExit } from "../fail.ts";
import { isInteractive, terminalLoginIO } from "../shared.ts";

export interface LoginOptions {
  /** `-g`: store in the user-global file, which an agent reads for a provider it has no other credential for. */
  global?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
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
