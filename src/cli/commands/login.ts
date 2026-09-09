/**
 * `fastagent login [provider]`: authenticate a model provider into the project-level auth file
 * (`<agentDir>/.secrets/auth.json`) by default, or `--auth-path`/`FASTAGENT_AUTH_PATH`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../../env.ts";
import { resolveAuthPath } from "../../engines/pi/config.ts";
import { GLOBAL_HOME_DIR, findAgentDir, placementDeadEnd } from "../../paths.ts";
import { LoginCancelled } from "../../engines/pi/login.ts";
import { installProxyFetch } from "../../proxy.ts";
import { failStartup, placementOrExit } from "../fail.ts";
import { isInteractive, loginWithKeyCheck } from "../shared.ts";

export interface LoginOptions {
  authPath?: string;
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
  loadDotEnv(loginDir); // FASTAGENT_AUTH_PATH / a proxy (HTTPS_PROXY) may be configured in the project .env
  installProxyFetch(); // the OAuth token exchange must go through HTTPS_PROXY (region-locked providers)
  const authPath = resolveAuthPath(loginDir, opts.authPath); // flag > FASTAGENT_AUTH_PATH > default — the one owner
  // Announce when the FALLBACK is what decided the target: outside an agent with no explicit path, the credential
  // lands somewhere no agent will read.
  if (!agentDir && !opts.authPath && !process.env.FASTAGENT_AUTH_PATH) {
    console.error(
      `[fastagent] no agent here (no fastagent.config.*, here or one level inside) — ` +
        `logging in GLOBALLY (${authPath}). An agent reads its own .secrets/auth.json: \`cd\` into one ` +
        `first, or point this run at it with --auth-path.`,
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
