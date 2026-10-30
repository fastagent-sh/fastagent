/**
 * `login --deployment <host>` with no one at a terminal: the ticket's process holds the box's shell while the person
 * signs in. The box is faked at the shell (its half runs in process, the real `stdioLoginIO` over `loginFlow`), so
 * everything from the ticket to the box's credential is the code that runs.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AuthInteraction, Credential, Provider } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { stdioLoginIO } from "../src/cli/login-relay.ts";
import { type Ticket, checkTicket, createTicket, runTicket } from "../src/cli/ticket.ts";
import { boxLoginStep } from "../src/cli/commands/deploy/shared.ts";
import type { BoxShell } from "../src/deploy/box-shell.ts";
import { LoginCancelled, loginFlow } from "../src/harnesses/models/login.ts";

const box = vi.hoisted(() => ({ provider: undefined as unknown, commands: [] as string[], authPath: "" }));

/** The box, at its shell: the command it was handed, and its half of the relay run against `box.provider`. */
const fakeShell: BoxShell = {
  async open(command) {
    box.commands.push(command);
    const toBox = new PassThrough();
    const fromBox = new PassThrough();
    const half = stdioLoginIO(toBox, fromBox);
    const closed = loginFlow(half.io, {
      authPath: box.authPath,
      provider: "codex",
      method: "oauth",
      providers: [box.provider as Provider],
    })
      .then(
        (result) => half.result({ ok: true, provider: result.provider, method: result.method, path: box.authPath }),
        (error: Error) =>
          half.result(
            error instanceof LoginCancelled
              ? { ok: false, reason: "cancelled", message: "cancelled" }
              : { ok: false, reason: "failed", message: error.message },
          ),
      )
      .then(() => {
        fromBox.end();
        return { opened: true as const, how: "exit 0" };
      });
    return { output: fromBox, input: toBox, closed };
  },
};
vi.mock("../src/cli/commands/deploy.ts", () => ({ HOSTS: { fly: { shell: async () => fakeShell } } }));
// At a terminal, so `--json` alone is what says a coding agent runs this: some run their commands in one.
vi.mock("../src/cli/shared.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/shared.ts")>()),
  isInteractive: () => true,
}));
const { runLogin } = await import("../src/cli/commands/login.ts");

const OAUTH: Credential = { type: "oauth", access: "tok", refresh: "rt", expires: Date.now() + 3_600_000 };
const exited = new Error("exited");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  box.commands.length = 0;
});

/** A box's account sign-in run as its ticket's process runs it; `ticket` once it has begun, `ended` once it has. */
async function signIn(login: (cb: AuthInteraction) => Promise<Credential>) {
  const dir = await mkdtemp(join(tmpdir(), "fa-box-ticket-"));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  box.authPath = join(dir, "box-auth.json");
  box.provider = { id: "codex", name: "Codex", getModels: () => [], auth: { oauth: { name: "Codex", login } } };
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  const { ticket } = createTicket({
    subject: "login:codex@fly",
    action: "sign in to Codex for the fly deployment",
    check: "fastagent login --check",
    restart: "fastagent login codex --method account --deployment fly",
    timeoutSeconds: 60,
  });
  const ended = runLogin("codex", { deployment: "fly", method: "account", ticket }).catch((error) => {
    if (error !== exited) throw error;
  });
  return { ticket, ended };
}

async function waitingOn(ticket: string): Promise<Ticket> {
  return vi.waitFor(async () => {
    const now = await checkTicket(ticket);
    if (now?.status !== "need_user_action") throw new Error(`still ${now?.status}`);
    return now;
  });
}

it("a browser sign-in waits on the person, takes the address --check --code brings, and the box keeps the login", async () => {
  const { ticket, ended } = await signIn(async (cb) => {
    cb.notify({ type: "auth_url", url: "https://auth.example/authorize" });
    const pasted = await cb.prompt({ type: "manual_code", message: "Paste the redirect URL" });
    if (pasted !== "http://localhost:1455/cb?code=abc") throw new Error(`unexpected ${pasted}`);
    return OAUTH;
  });
  expect(await waitingOn(ticket)).toMatchObject({ url: "https://auth.example/authorize", takesAddress: true });
  await checkTicket(ticket, "http://localhost:1455/cb?code=abc");
  await ended;
  expect(await checkTicket(ticket)).toMatchObject({ status: "done", result: { provider: "codex", deployment: "fly" } });
  expect(JSON.parse(await readFile(box.authPath, "utf8")).codex.type).toBe("oauth");
  expect(box.commands[0]).toContain("login --stdio codex --method account");
});

it("a device sign-in hands the person its code, and needs no address; a text question is left blank", async () => {
  let confirm: () => void = () => {};
  const confirmed = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  const { ticket, ended } = await signIn(async (cb) => {
    // Copilot's optional Enterprise domain, asked before its device code: left blank, as no one is there to answer.
    if ((await cb.prompt({ type: "text", message: "Enterprise domain" })) !== "") throw new Error("not blank");
    cb.notify({ type: "device_code", verificationUri: "https://auth.example/device", userCode: "AB-12" });
    await confirmed;
    return OAUTH;
  });
  const waiting = await waitingOn(ticket);
  expect(waiting).toMatchObject({ url: "https://auth.example/device", code: "AB-12" });
  expect(waiting.takesAddress).toBeUndefined();
  confirm();
  await ended;
  expect(await checkTicket(ticket)).toMatchObject({ status: "done" });
});

it("a secret the box asks for fails the ticket saying only a terminal can answer it, not that it was cancelled", async () => {
  const { ticket, ended } = await signIn(async (cb) => {
    await cb.prompt({ type: "secret", message: "Enter the key" });
    return OAUTH;
  });
  await ended;
  expect(await checkTicket(ticket)).toMatchObject({
    status: "failed",
    message:
      'the sign-in asks "Enter the key", which only a terminal can answer: run ' +
      "`fastagent login codex --deployment fly` in one",
  });
});

it("--json at a terminal is a coding agent's: nothing is asked, and a choice not given names its commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-box-ticket-"));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  await expect(runLogin(undefined, { deployment: "fly", json: true })).rejects.toBe(exited);
  expect(process.exit).toHaveBeenCalledWith(2);
  expect(JSON.parse(String(printed.mock.calls[0]?.[0]))).toMatchObject({ status: "need_choice" });
  expect(box.commands).toEqual([]);
});

it("a deploy's box login through its ticket: an account sign-in, its refusals named", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-box-step-"));
  box.authPath = join(dir, "box-auth.json");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const deployTicket = () =>
    createTicket({
      subject: "deploy:fly:x",
      action: "deploy the agent to fly",
      check: "fastagent deploy fly --check",
      restart: "fastagent deploy fly --run",
      timeoutSeconds: 60,
    }).ticket;
  const viaTicket = (ticket: string) =>
    runTicket(ticket, async (step) => {
      const { boxLogin } = boxLoginStep(
        "fly",
        { agentDir: dir, boxLogin: "codex", answerer: { kind: "ticket", step } },
        () => fakeShell,
      );
      const failed = await boxLogin?.run();
      if (failed) throw new Error(failed);
      return {};
    });

  box.provider = {
    id: "codex",
    name: "Codex",
    getModels: () => [],
    auth: {
      oauth: {
        name: "Codex",
        login: async (cb: AuthInteraction) => {
          cb.notify({ type: "auth_url", url: "https://auth.example/authorize" });
          await cb.prompt({ type: "manual_code", message: "Paste the redirect URL" });
          return OAUTH;
        },
      },
    },
  };
  const signedIn = deployTicket();
  const ran = viaTicket(signedIn);
  expect(await waitingOn(signedIn)).toMatchObject({ url: "https://auth.example/authorize", takesAddress: true });
  await checkTicket(signedIn, "http://localhost:1455/cb?code=abc");
  await ran;
  expect(await checkTicket(signedIn)).toMatchObject({ status: "done" });
  expect(box.commands[0]).toMatch(/login --stdio codex --method account --if-missing/);

  box.provider = {
    id: "codex",
    name: "Codex",
    getModels: () => [],
    auth: {
      oauth: {
        name: "Codex",
        login: async (cb: AuthInteraction) => {
          await cb.prompt({ type: "secret", message: "Enter the key" });
          return OAUTH;
        },
      },
    },
  };
  const refused = deployTicket();
  await viaTicket(refused);
  expect(await checkTicket(refused)).toMatchObject({
    status: "failed",
    message: expect.stringContaining('the sign-in asks "Enter the key", which only a terminal can answer'),
  });
});
