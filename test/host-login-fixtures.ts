import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserLogin, hostLogin } from "../src/cli/commands/deploy/host-login.ts";
import type { TicketStep } from "../src/cli/ticket.ts";

export async function cli(body: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fa-host-cli-")), "host");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** A ticket's step whose person's part is recorded; `handOver` is what `--check --code` brings. */
export function step() {
  const said: string[] = [];
  let handOver: (code: string) => void = () => {};
  const handed = new Promise<string>((resolve) => {
    handOver = resolve;
  });
  const fake: TicketStep = {
    signal: new AbortController().signal,
    person: { waitsOn: () => {}, carriesOn: () => said.push("carries on"), afterwards: () => {} },
    waits: (on) => said.push(`waits ${JSON.stringify(on)}`),
    address: () => handed,
  };
  return { fake, said, handOver };
}

export const flyLike = (bin: string): BrowserLogin => ({
  bin,
  atTerminal: ["auth", "login"],
  unattended: ["auth", "login"],
  address: /https:\/\/fly\.example\/cli\/[a-z0-9]+/,
  withCode: (code) => ["auth", "login", "--code", code],
});

export const signIn = (login: BrowserLogin, fake: TicketStep) => {
  const { hostLogin: run } = hostLogin(login, { kind: "ticket", step: fake }, tmpdir());
  return (run as () => Promise<string | undefined>)();
};
