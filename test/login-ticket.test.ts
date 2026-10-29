import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTicket, createTicket, runTicket, startTicket, ticketLogPath } from "../src/cli/login-ticket.ts";

afterEach(() => vi.restoreAllMocks());

const ticketFile = (ticket: string) =>
  join(process.env.HOME as string, ".fastagent", ".state", "logins", `${ticket}.json`);

/** Whether `pid` runs: signal 0 only asks. */
function running(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A sign-in started as `login` starts one, its process standing in for pi-ai's: it shows an address and waits. */
async function waitingSignIn(provider: string, name: string) {
  const waits = `
    const { readFileSync, writeFileSync } = require("node:fs");
    const path = require("node:path").join(process.env.HOME, ".fastagent", ".state", "logins", process.argv.at(-1) + ".json");
    const ticket = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...ticket, status: "need_user_action", url: "https://auth.example/a", pid: process.pid }));
    setInterval(() => {}, 1000);`;
  return startTicket({
    provider,
    name,
    authPath: "/nowhere",
    timeoutSeconds: 60,
    command: { file: process.execPath, args: ["-e", waits, "--"], cwd: tmpdir() },
  });
}

const ticketOf = () =>
  createTicket({ provider: "openai", name: "OpenAI", authPath: "/nowhere/auth.json", timeoutSeconds: 60 });

/** The run of a sign-in, settled from outside: `interaction` once it has started, `finish` to end it. */
function signIn() {
  let started: (interaction: AuthInteraction) => void = () => {};
  let finish: (error?: Error) => void = () => {};
  const interaction = new Promise<AuthInteraction>((resolve) => {
    started = resolve;
  });
  const run = (given: AuthInteraction) =>
    new Promise<{ model?: string }>((resolve, reject) => {
      started(given);
      finish = (error) => (error ? reject(error) : resolve({}));
    });
  return { run, interaction, finish: (error?: Error) => finish(error) };
}

describe("a sign-in that outlives the command that starts it", () => {
  it("a device sign-in hands back the address and the code to enter there", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ticket } = ticketOf();
    const sign = signIn();
    const running = runTicket(ticket, sign.run);
    (await sign.interaction).notify({
      type: "device_code",
      verificationUri: "https://auth.example/device",
      userCode: "ABCD-EFGH",
    });
    expect(await checkTicket(ticket)).toMatchObject({
      status: "need_user_action",
      url: "https://auth.example/device",
      code: "ABCD-EFGH",
      pid: process.pid,
    });
    sign.finish();
    await running;
    expect(await checkTicket(ticket)).toMatchObject({ status: "authorized" });
  });

  it("with no one to ask: a choice takes pi's default, a text question is left blank, a secret fails the sign-in", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ticket } = ticketOf();
    const answers: string[] = [];
    await runTicket(ticket, async (interaction) => {
      answers.push(
        await interaction.prompt({
          type: "select",
          message: "Select login method:",
          options: [
            { id: "browser", label: "Browser login (default)" },
            { id: "device_code", label: "Device code login" },
          ],
        }),
      );
      answers.push(await interaction.prompt({ type: "text", message: "Enterprise domain (blank for github.com)" }));
      await interaction.prompt({ type: "secret", message: "Enter the key" });
      return {};
    });
    expect(answers).toEqual(["browser", ""]);
    // The whole error, stack and all, goes to the log a failed ticket points at.
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/only a terminal/) }));
    expect(await checkTicket(ticket)).toMatchObject({
      status: "failed",
      message:
        'the sign-in asks "Enter the key", which only a terminal can answer: run `fastagent login openai` in one',
    });
  });

  it("a sign-in not finished in time expires", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ticket } = createTicket({ provider: "openai", name: "OpenAI", authPath: "/nowhere", timeoutSeconds: 1 });
    await runTicket(ticket, async (interaction) => {
      await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
      return {};
    });
    expect(await checkTicket(ticket)).toMatchObject({ status: "expired" });
  });

  it("a sign-in whose process stopped is failed, pointing at what it said", async () => {
    const { ticket } = ticketOf();
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => gone.on("exit", resolve));
    const path = ticketFile(ticket);
    const waiting = { ...JSON.parse(readFileSync(path, "utf8")), status: "need_user_action", pid: gone.pid };
    writeFileSync(path, JSON.stringify(waiting));
    expect(await checkTicket(ticket)).toMatchObject({
      status: "failed",
      message: `the sign-in stopped: ${ticketLogPath(ticket)} says why`,
    });
  });

  it("a newer sign-in to a provider stops one still waiting, which would hold its callback port", async () => {
    const openai = await waitingSignIn("openai", "OpenAI");
    const anthropic = await waitingSignIn("anthropic", "Anthropic");
    const newer = await waitingSignIn("openai", "OpenAI");
    try {
      expect(running(openai.pid)).toBe(false);
      expect(await checkTicket(openai.ticket)).toMatchObject({
        status: "failed",
        message: "replaced by a newer sign-in to OpenAI",
      });
      // Another provider's is left alone.
      expect(await checkTicket(anthropic.ticket)).toMatchObject({ status: "need_user_action" });
      expect(await checkTicket(newer.ticket)).toMatchObject({ status: "need_user_action" });
    } finally {
      for (const pid of [anthropic.pid, newer.pid]) if (running(pid)) process.kill(pid as number);
    }
  });

  it("a sign-in given up on for giving no address is stopped first, so it holds no port and writes nothing after", async () => {
    const sidecar = join(mkdtempSync(join(tmpdir(), "fa-ticket-pid-")), "pid");
    const silent = `require("node:fs").writeFileSync(${JSON.stringify(sidecar)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const given = await startTicket({
      provider: "openai",
      name: "OpenAI",
      authPath: "/nowhere",
      timeoutSeconds: 60,
      command: { file: process.execPath, args: ["-e", silent, "--"], cwd: tmpdir() },
      startTimeoutMs: 1_000,
    });
    expect(given).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/gave no address to open within 1s/),
    });
    expect(existsSync(sidecar) && running(Number(readFileSync(sidecar, "utf8")))).toBe(false);
  });

  it("an ended sign-in stays as it ended: a late writer cannot reopen it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ticket } = ticketOf();
    writeFileSync(
      ticketFile(ticket),
      JSON.stringify({
        ...JSON.parse(readFileSync(ticketFile(ticket), "utf8")),
        status: "failed",
        message: "replaced",
      }),
    );
    await runTicket(ticket, async () => ({}));
    expect(await checkTicket(ticket)).toMatchObject({ status: "failed", message: "replaced" });
  });

  it("names no file outside its directory: a ticket is 16 hex digits or nothing", async () => {
    const outside = join(process.env.HOME as string, ".fastagent", ".state", "outside.json");
    writeFileSync(outside, JSON.stringify({ ...JSON.parse(readFileSync(ticketFile(ticketOf().ticket), "utf8")) }));
    expect(await checkTicket("../outside")).toBeUndefined();
    expect(await checkTicket("0123456789abcdef")).toBeUndefined();
  });
});
