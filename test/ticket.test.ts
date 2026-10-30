import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failStartup } from "../src/cli/fail.ts";
import {
  type TicketStep,
  checkTicket,
  createTicket,
  runTicket,
  startTicket,
  ticketLogPath,
  ticketReport,
} from "../src/cli/ticket.ts";

afterEach(() => vi.restoreAllMocks());

const ticketFile = (ticket: string) =>
  join(process.env.HOME as string, ".fastagent", ".state", "tickets", `${ticket}.json`);

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

const request = (subject = "login:openai", timeoutSeconds = 60) => ({
  subject,
  action: "sign in to OpenAI",
  check: "fastagent login --check",
  restart: "fastagent login openai --method account",
  timeoutSeconds,
});

/** A step started as a command starts one, its process standing in for the step's: it shows an address and waits. */
async function waitingStep(subject: string, whenRunning: "replace" | "join" = "replace") {
  const waits = `
    const { readFileSync, writeFileSync } = require("node:fs");
    const path = require("node:path").join(process.env.HOME, ".fastagent", ".state", "tickets", process.argv.at(-1) + ".json");
    const ticket = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...ticket, status: "need_user_action", url: "https://auth.example/a", pid: process.pid }));
    setInterval(() => {}, 1000);`;
  return startTicket({
    ...request(subject),
    waitsFirst: true,
    whenRunning,
    command: { file: process.execPath, args: ["-e", waits, "--"], cwd: tmpdir() },
  });
}

/** A step's run, settled from outside: `step` once it has started, `finish` to end it. */
function steered() {
  let started: (step: TicketStep) => void = () => {};
  let finish: (error?: Error) => void = () => {};
  const step = new Promise<TicketStep>((resolve) => {
    started = resolve;
  });
  const run = (given: TicketStep) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      started(given);
      finish = (error) => (error ? reject(error) : resolve({ path: "/agent/.secrets/auth.json" }));
    });
  return { run, step, finish: (error?: Error) => finish(error) };
}

describe("a step that outlives the command that starts it", () => {
  it("waits on the person, carries on without them, and ends done, with what is left for them", async () => {
    const { ticket } = createTicket(request("add:feishu"));
    const steer = steered();
    const running = runTicket(ticket, steer.run);
    const step = await steer.step;
    step.waits({ url: "https://open.feishu.cn/confirm", code: "ABCD-EFGH" });
    expect(await checkTicket(ticket)).toMatchObject({
      status: "need_user_action",
      url: "https://open.feishu.cn/confirm",
      code: "ABCD-EFGH",
      pid: process.pid,
    });
    step.person.carriesOn();
    step.person.afterwards("Create and publish a version", "https://open.feishu.cn/app/cli_x/version");
    expect(await checkTicket(ticket)).toMatchObject({ status: "working" });
    steer.finish();
    await running;
    expect(await checkTicket(ticket)).toMatchObject({
      status: "done",
      result: { path: "/agent/.secrets/auth.json" },
      afterwards: [{ instructions: "Create and publish a version", url: "https://open.feishu.cn/app/cli_x/version" }],
    });
  });

  it("a step not finished in time expires, heeding the signal or not; one that throws fails, its error logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ticket } = createTicket(request("login:openai", 1));
    await runTicket(ticket, async (step) => {
      await step.address(step.signal);
      return undefined;
    });
    expect(await checkTicket(ticket)).toMatchObject({ status: "expired" });

    // One that never heeds the signal (a platform's own poll) expires all the same.
    const deaf = createTicket(request("add:feishu", 1)).ticket;
    await runTicket(deaf, () => new Promise(() => {}));
    expect(await checkTicket(deaf)).toMatchObject({ status: "expired" });

    const failing = createTicket(request()).ticket;
    await runTicket(failing, async () => {
      throw new Error("the person declined");
    });
    expect(await checkTicket(failing)).toMatchObject({ status: "failed", message: "the person declined" });
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: "the person declined" }));
  });

  it("a newer step for a subject stops one still waiting, which would hold what it holds", async () => {
    const openai = await waitingStep("login:openai");
    const feishu = await waitingStep("add:feishu");
    const newer = await waitingStep("login:openai");
    try {
      expect(running(openai.pid)).toBe(false);
      expect(await checkTicket(openai.ticket)).toMatchObject({
        status: "failed",
        message: "replaced by a newer attempt to sign in to OpenAI",
      });
      // Another subject's is left alone.
      expect(await checkTicket(feishu.ticket)).toMatchObject({ status: "need_user_action" });
      expect(await checkTicket(newer.ticket)).toMatchObject({ status: "need_user_action" });
    } finally {
      for (const pid of [feishu.pid, newer.pid]) if (running(pid)) process.kill(pid as number);
    }
  });

  it("a step that must not be stopped halfway is joined instead: the same ticket, its process left running", async () => {
    const first = await waitingStep("deploy:fly", "join");
    try {
      const again = await waitingStep("deploy:fly", "join");
      expect(again.ticket).toBe(first.ticket);
      expect(running(first.pid)).toBe(true);
    } finally {
      if (running(first.pid)) process.kill(first.pid as number);
    }
  });

  it("a failure that ends the process on its way out is the ticket's, with its reason", async () => {
    const { ticket } = createTicket(request("deploy:fly"));
    const exited = new Error("exited");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw exited;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runTicket(ticket, async () => failStartup(new Error("not logged in to Fly")));
    expect(await checkTicket(ticket)).toMatchObject({ status: "failed", message: "not logged in to Fly" });
  });

  it("a step given up on for giving the person nothing to do is stopped first, so it writes nothing after", async () => {
    const sidecar = join(mkdtempSync(join(tmpdir(), "fa-ticket-pid-")), "pid");
    const silent = `require("node:fs").writeFileSync(${JSON.stringify(sidecar)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const given = await startTicket({
      ...request(),
      waitsFirst: true,
      whenRunning: "replace",
      command: { file: process.execPath, args: ["-e", silent, "--"], cwd: tmpdir() },
      startTimeoutMs: 1_000,
    });
    expect(given).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/gave the person nothing to do within 1s/),
    });
    expect(existsSync(sidecar) && running(Number(readFileSync(sidecar, "utf8")))).toBe(false);
  });

  it("a step that may work a while first is returned working past the start timeout, its process carrying on", async () => {
    const sidecar = join(mkdtempSync(join(tmpdir(), "fa-ticket-pid-")), "pid");
    const busy = `require("node:fs").writeFileSync(${JSON.stringify(sidecar)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const given = await startTicket({
      ...request("add:lark"),
      waitsFirst: false,
      whenRunning: "replace",
      command: { file: process.execPath, args: ["-e", busy, "--"], cwd: tmpdir() },
      startTimeoutMs: 1_000,
    });
    // The child writes its pid as it starts, which a loaded machine can take past the start timeout.
    for (let tries = 0; !existsSync(sidecar) && tries < 50; tries++) await new Promise((r) => setTimeout(r, 100));
    const pid = Number(readFileSync(sidecar, "utf8"));
    try {
      expect(given).toMatchObject({ status: "working" });
      expect(running(pid)).toBe(true);
    } finally {
      process.kill(pid);
    }
  });

  it("a step whose process stopped is failed, pointing at what it said", async () => {
    const { ticket } = createTicket(request());
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => gone.on("exit", resolve));
    const waiting = {
      ...JSON.parse(readFileSync(ticketFile(ticket), "utf8")),
      status: "need_user_action",
      pid: gone.pid,
    };
    writeFileSync(ticketFile(ticket), JSON.stringify(waiting));
    expect(await checkTicket(ticket)).toMatchObject({
      status: "failed",
      message: `it stopped: ${ticketLogPath(ticket)} says why`,
    });
  });

  it("an ended step stays as it ended: a late writer cannot reopen it", async () => {
    const { ticket } = createTicket(request());
    const failed = { ...JSON.parse(readFileSync(ticketFile(ticket), "utf8")), status: "failed", message: "replaced" };
    writeFileSync(ticketFile(ticket), JSON.stringify(failed));
    await runTicket(ticket, async () => ({}));
    expect(await checkTicket(ticket)).toMatchObject({ status: "failed", message: "replaced" });
  });

  it("names no file outside its directory: a ticket is 16 hex digits or nothing", async () => {
    const outside = join(process.env.HOME as string, ".fastagent", ".state", "outside.json");
    writeFileSync(outside, readFileSync(ticketFile(createTicket(request()).ticket), "utf8"));
    expect(await checkTicket("../outside")).toBeUndefined();
    expect(await checkTicket("0123456789abcdef")).toBeUndefined();
  });
});

describe("a ticket as its command reports it", () => {
  const base = { ...createTicket(request()), status: "need_user_action" as const, url: "https://auth.example/a" };

  it("a waiting step: the address, the commands, and what the agent says to its user", () => {
    expect(ticketReport({ ...base, takesAddress: true }, "started").json).toMatchObject({
      status: "need_user_action",
      url: "https://auth.example/a",
      check_command: `fastagent login --check ${base.ticket} --json`,
      resume_command: `fastagent login --check ${base.ticket} --code '<address>' --json`,
      agent_next_steps: expect.stringMatching(/^Give the URL to the user so they can sign in to OpenAI\. /),
    });
    const device = ticketReport({ ...base, code: "ABCD" }, "checked").json;
    expect(device).not.toHaveProperty("resume_command");
    expect(device.agent_next_steps).toMatch(/^The user has not finished yet\. Give the URL and the code ABCD/);
  });

  it("a done step: its own fields, what is left for the person, and the step's own sentence", () => {
    const done = {
      ...base,
      status: "done" as const,
      result: { path: "/a" },
      afterwards: [{ instructions: "Publish a version", url: "https://p" }],
    };
    expect(ticketReport(done, "checked", (result) => ({ fields: result, text: [], next: "Signed in." })).json).toEqual({
      status: "done",
      ticket: base.ticket,
      path: "/a",
      afterwards: [{ instructions: "Publish a version", url: "https://p" }],
      agent_next_steps: "Signed in. Tell the user what is left for them: Publish a version https://p",
    });
  });

  it("working, failed and expired: what the agent does next", () => {
    expect(ticketReport({ ...base, status: "working" }, "checked").json.agent_next_steps).toMatch(
      /Run check_command again/,
    );
    expect(ticketReport({ ...base, status: "failed", message: "no" }, "checked").json).toMatchObject({
      message: "no",
      agent_next_steps: "To try again, run: fastagent login openai --method account --json",
    });
    expect(ticketReport({ ...base, status: "expired" }, "checked").json).toMatchObject({
      message: "it was not finished in time",
    });
  });
});

describe("an account sign-in with no one to answer it (login's ticket)", () => {
  const stepOf = () => {
    const waited: unknown[] = [];
    const step = {
      signal: new AbortController().signal,
      person: { waitsOn: () => {}, carriesOn: () => {}, afterwards: () => {} },
      waits: (on: unknown) => void waited.push(on),
      address: async () => "http://localhost:1455/cb?code=c",
    } satisfies TicketStep;
    return { step, waited };
  };

  it("a choice takes pi's default, a text question is left blank, a secret fails it naming the terminal", async () => {
    const { signInInteraction } = await import("../src/cli/commands/login.ts");
    const interaction = signInInteraction(stepOf().step, "openai");
    const options = [
      { id: "browser", label: "Browser login (default)" },
      { id: "device_code", label: "Device code login" },
    ];
    expect(await interaction.prompt({ type: "select", message: "Select login method:", options })).toBe("browser");
    expect(await interaction.prompt({ type: "text", message: "Enterprise domain (blank for github.com)" })).toBe("");
    await expect(interaction.prompt({ type: "secret", message: "Enter the key" })).rejects.toThrow(
      'the sign-in asks "Enter the key", which only a terminal can answer: run `fastagent login openai` in one',
    );
    expect(await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" })).toBe(
      "http://localhost:1455/cb?code=c",
    );
  });

  it("a browser sign-in takes an address; a device sign-in hands back its code instead", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { signInInteraction } = await import("../src/cli/commands/login.ts");
    const { step, waited } = stepOf();
    const interaction = signInInteraction(step, "openai");
    interaction.notify({ type: "auth_url", url: "https://auth.example/authorize" });
    interaction.notify({ type: "device_code", verificationUri: "https://auth.example/device", userCode: "ABCD" });
    expect(waited).toEqual([
      { url: "https://auth.example/authorize", takesAddress: true },
      { url: "https://auth.example/device", code: "ABCD" },
    ]);
  });
});
