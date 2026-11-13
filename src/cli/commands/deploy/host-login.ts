/**
 * Signing a host's CLI in to the person's account, for a deploy that finds it signed out. At a terminal the host's own
 * login runs there and opens the browser.
 */
import { spawn } from "node:child_process";
import type { Answerer } from "./shared.ts";

export interface BrowserLogin {
  bin: string;
  atTerminal: string[];
}

export const FLY_LOGIN: BrowserLogin = {
  bin: "fly",
  atTerminal: ["auth", "login"],
};

export const RAILWAY_LOGIN: BrowserLogin = {
  bin: "railway",
  atTerminal: ["login"],
};

/**
 * The host's sign-in when an interactive terminal is present; none for `nobody`, whose deploy stops at the host's own
 * gate. Resolves undefined once signed in, else the line saying why not.
 */
export function hostLogin(
  login: BrowserLogin,
  answerer: Answerer,
  cwd: string,
): { hostLogin?: () => Promise<string | undefined> } {
  if (answerer.kind === "nobody") return {};
  return {
    hostLogin: async () => {
      const code = await exitOf(spawn(login.bin, login.atTerminal, { cwd, stdio: "inherit" }));
      return code === 0 ? undefined : `\`${login.bin} ${login.atTerminal.join(" ")}\` did not sign in — re-run`;
    },
  };
}

function exitOf(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
