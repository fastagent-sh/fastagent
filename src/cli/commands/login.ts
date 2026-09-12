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
import { LoginCancelled } from "../../engines/pi/login.ts";
import { failStartup, placementOrExit } from "../fail.ts";
import { isInteractive, loginWithKeyCheck } from "../shared.ts";

export interface LoginOptions {
  /** `-g`: store in the user-global file every agent on this machine falls back to. */
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
        `logging in GLOBALLY (${authPath}). Every agent on this machine reads this file for providers its own ` +
        `.secrets/auth.json does not have, so this is usually what you want; \`cd\` into an agent to give that ` +
        `one its own account instead.`,
    );
  }
  // login is inherently interactive — loginFlow renders provider/method menus and opens a browser (or prompts for a
  // key).
  if (opts.input === false || !isInteractive()) {
    failStartup(
      new Error(`login is interactive (it shows a menu and opens a browser) — run it in a terminal, not a pipe/CI`),
    );
  }
  // loginWithKeyCheck: an entered API key is verified with one minimal request.
  const result = await loginWithKeyCheck(provider, authPath).catch((error: unknown) => {
    if (error instanceof LoginCancelled) {
      // A decision, not a failure — neutral wording; non-zero exit because no credential was stored.
      console.error(`[fastagent] login cancelled`);
      process.exit(1);
    }
    failStartup(error);
  });
  console.error(`[fastagent] logged in to ${result.provider} (${result.method}) — saved to ${authPath}`);
  process.exit(0); // the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
}
