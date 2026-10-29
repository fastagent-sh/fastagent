import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTicket, createTicket, runTicket, ticketLogPath } from "../src/cli/login-ticket.ts";

afterEach(() => vi.restoreAllMocks());

const ticketFile = (ticket: string) =>
  join(process.env.HOME as string, ".fastagent", ".state", "logins", `${ticket}.json`);

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
    vi.spyOn(console, "error").mockImplementation(() => {});
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

  it("names no file outside its directory: a ticket is 16 hex digits or nothing", async () => {
    const outside = join(process.env.HOME as string, ".fastagent", ".state", "outside.json");
    writeFileSync(outside, JSON.stringify({ ...JSON.parse(readFileSync(ticketFile(ticketOf().ticket), "utf8")) }));
    expect(await checkTicket("../outside")).toBeUndefined();
    expect(await checkTicket("0123456789abcdef")).toBeUndefined();
  });
});
