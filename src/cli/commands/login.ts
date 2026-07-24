/**
 * `fastagent login [provider]`: authenticate a model provider into the project-level auth file
 * (`<workspaceRoot>/.secrets/auth.json`) by default, or `--auth-path`/`FASTAGENT_AUTH_PATH`. The
 * positional is the PROVIDER (not a dir), so the workspace resolves from cwd — `cd` into your agent
 * before logging in (running it from $HOME writes the global `~/.fastagent/.secrets/auth.json`).
 *
 * Creates and self-ignores `<root>/.secrets/` (the credential's gitignored home) BEFORE the auth flow,
 * so the secret can never land untracked — a flow that then fails (bad provider, abort) leaves that
 * empty secrets dir behind, by design (no secret without its `.gitignore`). Skipped for the HOME-global dir.
 */
import { loadDotEnv } from "../../env.ts";
import { resolveAuthPath, resolveSecretsDir, resolveWorkspace } from "../../engines/pi/config.ts";
import { ensureSecretsDirSelfIgnored, isUnderDir } from "../../engines/pi/definition.ts";
import { LoginCancelled } from "../../engines/pi/login.ts";
import { installProxyFetch } from "../../proxy.ts";
import { failStartup, failStartupOn } from "../fail.ts";
import { isInteractive, loginWithKeyCheck } from "../shared.ts";

export interface LoginOptions {
  authPath?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  const { root: loginDir } = failStartupOn(() => resolveWorkspace(process.cwd()));
  loadDotEnv(loginDir); // FASTAGENT_AUTH_PATH / a proxy (HTTPS_PROXY) may be configured in the project .env
  installProxyFetch(); // the OAuth token exchange must go through HTTPS_PROXY (region-locked providers)
  const secretsDir = resolveSecretsDir(loginDir);
  const authPath = resolveAuthPath(loginDir, opts.authPath); // flag > FASTAGENT_AUTH_PATH > default — the one owner
  // login is the command that CREATES the credential file, so the leak guard binds HERE too (not only
  // in the opener): on an adapted project dir, a `login` before the first dev/start would otherwise
  // leave the secret untracked-but-committable. Unlike the opener (which always guards the machinery
  // dirs), login writes ONLY auth.json — so guard iff the credential actually lands under the in-tree
  // secrets dir. An external `--auth-path`/`FASTAGENT_AUTH_PATH` writes nothing in-tree (don't create
  // an empty `.secrets`); the guard also skips the HOME-global dir.
  if (isUnderDir(authPath, secretsDir)) await ensureSecretsDirSelfIgnored(loginDir, secretsDir);
  // login is inherently interactive — loginFlow renders provider/method menus and opens a browser (or
  // prompts for a key). In a non-TTY (a pipe, CI, a coding-agent shell) the menu can't receive keystrokes
  // and would hang; --no-input asks for the same posture explicitly. Fail fast with the reason instead
  // of stalling on an unanswerable prompt. (After the secret-hygiene self-ignore above, which is cheap
  // prep, so a later terminal login is safe.)
  if (opts.input === false || !isInteractive()) {
    failStartup(
      new Error(`login is interactive (it shows a menu and opens a browser) — run it in a terminal, not a pipe/CI`),
    );
  }
  // loginWithKeyCheck: an entered API key is verified with one minimal request; a rejected key (401)
  // re-prompts in place, so a returned result is always a stored-and-not-definitively-bad credential.
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
