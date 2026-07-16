/**
 * `fastagent login [provider]`: authenticate a model provider into the project-level auth file
 * (`<cwd>/.fastagent/auth.json`) by default, or `--auth-path`/`FASTAGENT_AUTH_PATH`. The positional is
 * the PROVIDER (not a dir), so the project is cwd — `cd` into your agent before logging in (running it
 * from $HOME writes the global `~/.fastagent/auth.json`).
 *
 * Creates and self-ignores `<cwd>/.fastagent/` (the credential's gitignored home) BEFORE the auth flow,
 * so the secret can never land untracked — a flow that then fails (bad provider, abort) leaves that
 * empty state dir behind, by design (no secret without its `.gitignore`). Skipped for the HOME-global dir.
 */
import { autocomplete, isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import { loadDotEnv } from "../../env.ts";
import { defaultAuthPath, resolveAuthPathOverride, resolveStateRoot } from "../../engines/pi/config.ts";
import { ensureStateRootSelfIgnored, isUnderDir } from "../../engines/pi/definition.ts";
import { type LoginIO, loginFlow } from "../../engines/pi/login.ts";
import { openExternalUrl } from "../../open-url.ts";
import { installProxyFetch } from "../../proxy.ts";
import { failStartup } from "../fail.ts";
import { isInteractive } from "../shared.ts";

export interface LoginOptions {
  authPath?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runLogin(provider: string | undefined, opts: LoginOptions): Promise<void> {
  const loginDir = process.cwd();
  loadDotEnv(loginDir); // FASTAGENT_AUTH_PATH / a proxy (HTTPS_PROXY) may be configured in the project .env
  installProxyFetch(); // the OAuth token exchange must go through HTTPS_PROXY (region-locked providers)
  const stateRoot = resolveStateRoot(loginDir);
  const authPath = resolveAuthPathOverride(opts.authPath) ?? defaultAuthPath(stateRoot);
  // login is the command that CREATES the credential file, so the leak guard binds HERE too (not only
  // in the opener): on an adapted project dir, a `login` before the first dev/start would otherwise
  // leave the secret untracked-but-committable. Unlike the opener (which populates the WHOLE root, so
  // it always self-ignores an in-tree root), login writes ONLY auth.json — so guard iff the credential
  // actually lands under the in-tree root. An external `--auth-path`/`FASTAGENT_AUTH_PATH` writes
  // nothing in-tree (don't create an empty `.fastagent`); the guard also skips the HOME-global root.
  if (isUnderDir(authPath, stateRoot)) await ensureStateRootSelfIgnored(loginDir, stateRoot);
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
  const io = terminalLoginIO();
  const result = await loginFlow(io, { provider, authPath }).catch(failStartup);
  console.error(`[fastagent] logged in to ${result.provider} (${result.method}) — saved to ${authPath}`);
  process.exit(0); // the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
}

/** Login terminal IO via @clack/prompts: a searchable list once long, a hidden prompt for keys. */
function terminalLoginIO(): LoginIO {
  return {
    async select(message, options) {
      const r = await (options.length > 7 ? autocomplete : select)({ message, options });
      return isCancel(r) ? undefined : (r as string);
    },
    async prompt(message, opts) {
      const r = opts?.hidden
        ? await password({ message, signal: opts.signal })
        : await clackText({ message, signal: opts?.signal });
      return isCancel(r) ? undefined : (r as string);
    },
    note: (message) => clackLog.info(message),
    openUrl: openExternalUrl,
  };
}
