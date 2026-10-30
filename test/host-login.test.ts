/**
 * A host CLI's browser sign-in run by a deploy's ticket: the address it prints is the person's step, and the deploy
 * carries on once the CLI says it is signed in. The CLIs are stand-in scripts speaking as `fly auth login` and
 * `railway login --browserless` do with no terminal.
 */
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type BrowserLogin, hostLogin } from "../src/cli/commands/deploy/host-login.ts";
import type { TicketStep } from "../src/cli/ticket.ts";

afterEach(() => vi.restoreAllMocks());

async function cli(body: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "fa-host-cli-")), "host");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** A ticket's step whose person's part is recorded; `handOver` is what `--check --code` brings. */
function step() {
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

const flyLike = (bin: string): BrowserLogin => ({
  bin,
  atTerminal: ["auth", "login"],
  unattended: ["auth", "login"],
  address: /https:\/\/fly\.example\/cli\/[a-z0-9]+/,
  withCode: (code) => ["auth", "login", "--code", code],
});

const signIn = (login: BrowserLogin, fake: TicketStep) => {
  const { hostLogin: run } = hostLogin(login, { kind: "ticket", step: fake }, tmpdir());
  return (run as () => Promise<string | undefined>)();
};

it("waits on the person at the address the CLI prints, and carries on once it says it is signed in", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const bin = await cli('echo "Open this URL: https://fly.example/cli/abc123"; sleep 1; exit 0');
  const { fake, said } = step();
  expect(await signIn(flyLike(bin), fake)).toBeUndefined();
  expect(said).toEqual([
    `waits ${JSON.stringify({ url: "https://fly.example/cli/abc123", takesAddress: true })}`,
    "carries on",
  ]);
});

it("a device sign-in's code goes with its address, and it takes none handed back", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const bin = await cli('echo "→ https://railway.example/activate?user_code=AB-12" >&2; sleep 1');
  const { fake, said } = step();
  const login: BrowserLogin = {
    bin,
    atTerminal: ["login"],
    unattended: ["login", "--browserless"],
    address: /https:\/\/railway\.example\/activate\?user_code=[A-Z0-9-]+/,
    userCode: (address) => address.searchParams.get("user_code") ?? undefined,
  };
  expect(await signIn(login, fake)).toBeUndefined();
  expect(said[0]).toBe(
    `waits ${JSON.stringify({ url: "https://railway.example/activate?user_code=AB-12", code: "AB-12" })}`,
  );
});

it("a code the approval page showed finishes the sign-in, the waiting login stopped; a wrong one is said", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const marks = await mkdtemp(join(tmpdir(), "fa-host-marks-"));
  // Takes exactly the page's code, as pasted with the whitespace around it trimmed.
  const bin = await cli(
    `if [ "$3" = "--code" ]; then echo "$4" > "${marks}/code"; [ "$4" = "one-time-code" ]; exit $?; fi\n` +
      'echo "https://fly.example/cli/abc123"; sleep 30',
  );
  const handing = async (code: string) => {
    const { fake, said, handOver } = step();
    const done = signIn(flyLike(bin), fake);
    // A stand-in CLI's start, which a loaded machine can take past waitFor's default second.
    await vi.waitFor(() => expect(said).toHaveLength(1), { timeout: 10_000 });
    handOver(code);
    return { answer: await done, said };
  };
  const right = await handing(" one-time-code \n");
  expect(right.answer).toBeUndefined();
  expect(await readFile(join(marks, "code"), "utf8")).toBe("one-time-code\n");
  expect(right.said.at(-1)).toBe("carries on");

  const wrong = await handing("another-code");
  expect(wrong.answer).toBe(`\`${bin}\` refused the code the approval page showed — try the deploy again`);
  expect(wrong.said).not.toContain("carries on");
});

it("a login that fails says so with what the CLI said", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const bin = await cli('echo "Error: network unreachable" >&2; exit 1');
  const { fake } = step();
  expect(await signIn(flyLike(bin), fake)).toBe(
    `\`${bin} auth login\` did not sign in (exit 1): Error: network unreachable`,
  );
});

it("nobody gets no sign-in: the deploy stops at the host's own gate", () => {
  expect(hostLogin(flyLike("fly"), { kind: "nobody" }, tmpdir())).toEqual({});
});

it("at a terminal the host's own login runs there, and one that does not sign in says so", async () => {
  const signedIn = await cli('[ "$1 $2" = "auth login" ]');
  const terminal = hostLogin(flyLike(signedIn), { kind: "terminal" }, tmpdir()).hostLogin;
  expect(await terminal?.()).toBeUndefined();
  const refused = await cli("exit 1");
  expect(await hostLogin(flyLike(refused), { kind: "terminal" }, tmpdir()).hostLogin?.()).toBe(
    `\`${refused} auth login\` did not sign in — re-run`,
  );
});
