/**
 * Signing a host's CLI in to the person's account, for a deploy that finds it signed out. At a terminal the host's own
 * login runs there and opens the browser. In a deploy's ticket it runs with no terminal, where both CLIs print the
 * address to approve at and finish on their own once approved; that address is the person's step. Never a token: one
 * set in .secrets/production/.env would travel to the box with every other variable there.
 */
import { spawn } from "node:child_process";
import type { Answerer } from "./shared.ts";

export interface BrowserLogin {
  bin: string;
  /** The login at a terminal: it opens the browser itself. */
  atTerminal: string[];
  /** The login with no terminal: it prints the address, and exits 0 once the person approved there. */
  unattended: string[];
  /** The address in what `unattended` prints. */
  address: RegExp;
  /** The code a device login's address carries, for the person to check against the page. */
  userCode?(address: URL): string | undefined;
  /**
   * The login that finishes with the code the approval page shows, for a browser that could not reach this machine
   * (Fly's): `deploy --check <ticket> --code <code>` hands it over.
   */
  withCode?(code: string): string[];
}

export const FLY_LOGIN: BrowserLogin = {
  bin: "fly",
  atTerminal: ["auth", "login"],
  unattended: ["auth", "login"],
  address: /https:\/\/fly\.io\/app\/auth\/cli\/[A-Za-z0-9_-]+/,
  withCode: (code) => ["auth", "login", "--code", code],
};

export const RAILWAY_LOGIN: BrowserLogin = {
  bin: "railway",
  atTerminal: ["login"],
  unattended: ["login", "--browserless"],
  address: /https:\/\/railway\.com\/activate\?user_code=[A-Za-z0-9-]+/,
  userCode: (address) => address.searchParams.get("user_code") ?? undefined,
};

/**
 * The host's sign-in, through whoever answers, as a driver's `hostLogin`; none for nobody, whose deploy stops at the
 * host's own gate. Resolves undefined once signed in, else the line saying why not.
 */
export function hostLogin(
  login: BrowserLogin,
  answerer: Answerer,
  cwd: string,
): { hostLogin?: () => Promise<string | undefined> } {
  if (answerer.kind === "nobody") return {};
  return { hostLogin: signIn(login, answerer, cwd) };
}

function signIn(
  login: BrowserLogin,
  answerer: Exclude<Answerer, { kind: "nobody" }>,
  cwd: string,
): () => Promise<string | undefined> {
  if (answerer.kind === "terminal") {
    return async () => {
      const code = await exitOf(spawn(login.bin, login.atTerminal, { cwd, stdio: "inherit" }));
      return code === 0 ? undefined : `\`${login.bin} ${login.atTerminal.join(" ")}\` did not sign in — re-run`;
    };
  }
  const { step } = answerer;
  return async () => {
    const child = spawn(login.bin, login.unattended, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    let shown = false;
    const hear = (chunk: Buffer): void => {
      const text = String(chunk);
      process.stderr.write(text);
      said = `${said}${text}`.slice(-4096);
      const found = shown ? null : login.address.exec(said);
      if (found === null) return;
      shown = true;
      const url = found[0];
      const code = login.userCode?.(new URL(url));
      step.waits(code ? { url, code } : login.withCode ? { url, takesAddress: true } : { url });
    };
    child.stdout.on("data", hear);
    child.stderr.on("data", hear);
    const exited = exitOf(child);
    const handed = new AbortController();
    const finished = await Promise.race([
      exited.then((code) => ({ code })),
      ...(login.withCode
        ? [
            step
              .address(AbortSignal.any([step.signal, handed.signal]))
              .then((code) => ({ handedCode: code.trim() }))
              .catch(() => new Promise<never>(() => {})),
          ]
        : []),
    ]);
    handed.abort();
    if ("handedCode" in finished) {
      child.kill();
      const args = (login.withCode as (code: string) => string[])(finished.handedCode);
      const code = await exitOf(spawn(login.bin, args, { cwd, stdio: ["ignore", "inherit", "inherit"] }));
      if (code !== 0) return `\`${login.bin}\` refused the code the approval page showed — try the deploy again`;
    } else if (finished.code !== 0) {
      return `\`${login.bin} ${login.unattended.join(" ")}\` did not sign in (exit ${finished.code}): ${said.trim()}`;
    }
    step.person.carriesOn();
    return undefined;
  };
}

function exitOf(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
