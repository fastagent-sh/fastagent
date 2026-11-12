/**
 * `login --method account` without a terminal, for a coding agent: a ticket the person finishes. The command that starts
 * it, the step that runs it and the command that reads it are each tested where they are decided, in this process. That
 * a step outlives the command that starts it is `startTicket`'s, and tested with real processes in ticket.test.ts.
 */
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTicket, createTicket, endTicket } from "../src/cli/ticket.ts";
import { agentWorkspace, runInProcess, withRepoModules } from "./cli-run.ts";

/** What the command asked `startTicket` to start: the step's own process is run by hand below. */
const started: unknown[] = [];
vi.mock("../src/cli/ticket.ts", async (original) => {
  const real = await original<typeof import("../src/cli/ticket.ts")>();
  return {
    ...real,
    startTicket: async (input: Parameters<typeof real.startTicket>[0]) => {
      started.push(input);
      return {
        ...real.createTicket(input),
        status: "need_user_action" as const,
        url: "https://auth.example/authorize?state=s",
        takesAddress: true,
      };
    },
  };
});

afterEach(() => started.splice(0));

const REQUEST = {
  subject: "login:openai",
  action: "sign in to OpenAI",
  check: "fastagent login --check",
  restart: "fastagent login openai --method account",
  timeoutSeconds: 60,
  fields: { provider: "openai", method: "account" },
};

/** An agent whose provider in code replaces `openai`: a sign-in that shows an address, then takes the one the browser ends on. */
async function signInAgent(): Promise<string> {
  const dir = await agentWorkspace("fa-login-ticket-", {
    "fastagent.config.ts": `import { createProvider } from "@earendil-works/pi-ai";
const never = () => { throw new Error("no message is sent"); };
export default { providers: [createProvider({ id: "openai", name: "OpenAI", models: [], api: { stream: never, streamSimple: never },
  auth: { oauth: { name: "ChatGPT", refresh: async (c) => c, toAuth: async (c) => ({ apiKey: c.access }),
    login: async (interaction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.example/authorize?state=s" });
      const address = new URL(await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" }));
      if (address.searchParams.has("error")) throw new Error("the person declined");
      return { type: "oauth", access: "a-" + address.searchParams.get("code"), refresh: "r", expires: Date.now() + 3600000 };
    } } } })] };\n`,
  });
  await withRepoModules(dir);
  return dir;
}

const ticketFile = (id: string) => join(process.env.HOME as string, ".fastagent", ".state", "tickets", `${id}.json`);
const ticketOf = async (id: string) => JSON.parse(await readFile(ticketFile(id), "utf8")) as Record<string, unknown>;

/**
 * The step of a ticket, as the process `startTicket` starts would run it: this process, for as long as the step lasts,
 * waiting on its person when this returns. `ended` settles when the step does. Nothing else is run through
 * `runInProcess` meanwhile (it would swap the step's working directory and environment out from under it): the person's
 * side is `checkTicket`, which reads and writes the ticket's files and nothing more. Wrapped in an object, since a
 * promise returned from an async function is waited for, and the step ends only once its person has answered.
 */
async function stepOf(dir: string, id: string) {
  const ended = runInProcess(["login", "openai", "--method", "account", "--ticket", id], dir);
  await vi.waitFor(async () => expect((await ticketOf(id)).status).toBe("need_user_action"), { timeout: 20_000 });
  return { ended };
}

describe("login --method account, without a terminal", () => {
  it("asks for a ticket for the person's sign-in and reports its address and how to check it", async () => {
    const dir = await signInAgent();
    const result = await runInProcess(["login", "openai", "--method", "account", "--json"], dir);
    expect(result.code).toBe(0);
    const [asked] = started as [Record<string, unknown> & { command: { args: string[] } }];
    expect(asked).toMatchObject({
      subject: "login:openai",
      action: "sign in to OpenAI",
      fields: { provider: "openai", method: "account" },
      waitsFirst: true,
      whenRunning: "replace", // a newer attempt stops one waiting on its person: both hold the same callback port
    });
    expect(asked.command.args.slice(-4)).toEqual(["login", "openai", "--method", "account"]);
    const ticket = JSON.parse(result.stdout);
    expect(ticket).toMatchObject({
      status: "need_user_action",
      provider: "openai",
      method: "account",
      url: "https://auth.example/authorize?state=s",
      check_command: `fastagent login --check ${ticket.ticket} --json`,
      resume_command: `fastagent login --check ${ticket.ticket} --code '<address>' --json`,
      agent_next_steps: expect.stringMatching(/^Give the URL to the user so they can sign in to OpenAI\./),
    });
  });

  it("a step shows its person an address and takes the one their browser ends on, writes the credential, and is done", async () => {
    const dir = await signInAgent();
    const { ticket } = createTicket(REQUEST);
    const { ended } = await stepOf(dir, ticket);
    expect(await ticketOf(ticket)).toMatchObject({
      url: "https://auth.example/authorize?state=s",
      takesAddress: true,
    });
    const done = await checkTicket(ticket, "http://localhost:1455/auth/callback?code=xyz");
    expect(done).toMatchObject({
      status: "done",
      // The path the step names is the real one: the step's working directory is what `process.cwd()` says of it.
      result: {
        provider: "openai",
        path: join(await realpath(dir), ".secrets", "auth.json"),
        model: "openai/gpt-6.1-sol",
      },
    });
    expect((await ended).code).toBe(0);
    expect(JSON.parse(await readFile(join(dir, ".secrets", "auth.json"), "utf8")).openai).toMatchObject({
      type: "oauth",
      access: "a-xyz",
    });
  });

  it("a person who declines ends the ticket failed, with the reason, and writes no credential", async () => {
    const dir = await signInAgent();
    const { ticket } = createTicket(REQUEST);
    const { ended } = await stepOf(dir, ticket);
    const failed = await checkTicket(ticket, "http://localhost/cb?error=denied");
    expect(failed).toMatchObject({ status: "failed", message: "the person declined" });
    await ended;
    expect(JSON.parse(await readFile(join(dir, ".secrets", "auth.json"), "utf8"))).toEqual({});
  });

  describe("--check", () => {
    it("reports a finished ticket as the step left it, and ends 0 for done and 1 for failed", async () => {
      const dir = await signInAgent();
      const done = createTicket(REQUEST).ticket;
      endTicket(done, { status: "done", result: { provider: "openai", path: join(dir, ".secrets", "auth.json") } });
      const ok = await runInProcess(["login", "--check", done, "--json"], dir);
      expect([ok.code, JSON.parse(ok.stdout)]).toEqual([
        0,
        expect.objectContaining({ status: "done", provider: "openai", ticket: done }),
      ]);

      const bad = createTicket(REQUEST).ticket;
      endTicket(bad, { status: "failed", message: "the person declined" });
      const refused = await runInProcess(["login", "--check", bad, "--json"], dir);
      expect([refused.code, JSON.parse(refused.stdout)]).toEqual([
        1,
        expect.objectContaining({ status: "failed", message: "the person declined" }),
      ]);
    });

    it("refuses what names no ticket, and an address with nothing to hand it to, as a usage error", async () => {
      const dir = await signInAgent();
      expect((await runInProcess(["login", "--check", "not-a-ticket"], dir)).code).toBe(2);
      const orphan = await runInProcess(["login", "openai", "--code", "http://localhost/cb?code=x"], dir);
      expect([orphan.code, orphan.stderr]).toEqual([2, expect.stringContaining("--check")]);
    });
  });
});
