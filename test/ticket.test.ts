import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failStartup } from "../src/cli/fail.ts";
import {
  type Ticket,
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
/**
 * What a step's process starts, as a tunnel would be: told SIGTERM, it notes it in `<sidecar>.term` and carries on, so
 * only SIGKILL stops it.
 */
const stubborn = (sidecar: string) => `
  process.on("SIGTERM", () => require("node:fs").writeFileSync(${JSON.stringify(`${sidecar}.term`)}, "term"));
  require("node:fs").writeFileSync(${JSON.stringify(sidecar)}, String(process.pid));
  setInterval(() => {}, 1000);`;

async function waitingStep(
  subject: string,
  {
    status = "need_user_action",
    sidecar,
    finishing = false,
    whenRunning = "replace",
  }: { status?: string; sidecar?: string; finishing?: boolean; whenRunning?: "replace" | "join" } = {},
) {
  const waits = `
    const { readFileSync, writeFileSync } = require("node:fs");
    const path = require("node:path").join(process.env.HOME, ".fastagent", ".state", "tickets", process.argv.at(-1) + ".json");
    const ticket = JSON.parse(readFileSync(path, "utf8"));
    ${sidecar === undefined ? "" : `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(stubborn(sidecar))}], { stdio: "ignore" });`}
    ${sidecar === undefined ? "" : `while (!require("node:fs").existsSync(${JSON.stringify(sidecar)})) {}`}
    writeFileSync(path, JSON.stringify({ ...ticket, status: ${JSON.stringify(status)}, ${finishing ? "finishing: true, " : ""}url: "https://auth.example/a", pid: process.pid }));
    setInterval(() => {}, 1000);`;
  return startTicket({
    ...request(subject),
    waitsFirst: status === "need_user_action",
    whenRunning,
    // A step at work is answered as it stands once the start window passes.
    ...(status === "working" ? { startTimeoutMs: 1_000 } : {}),
    command: { file: process.execPath, args: ["-e", waits, "--"], cwd: tmpdir() },
  });
}

/** A sidecar file, to which a step's process writes the pid of what it started. */
const sidecarFile = () => join(mkdtempSync(join(tmpdir(), "fa-ticket-pid-")), "pid");

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
    // The step's own write as it starts: at work, nothing for the person yet.
    const claimed = await checkTicket(ticket);
    expect(claimed).toMatchObject({ status: "working", pid: process.pid });
    // Only getting ready: a newer attempt may still replace it.
    expect(claimed).not.toHaveProperty("finishing");
    step.waits({ url: "https://open.feishu.cn/confirm", code: "ABCD-EFGH" });
    expect(await checkTicket(ticket)).toMatchObject({
      status: "need_user_action",
      url: "https://open.feishu.cn/confirm",
      code: "ABCD-EFGH",
      pid: process.pid,
    });
    step.person.carriesOn();
    step.person.afterwards("Create and publish a version", "https://open.feishu.cn/app/cli_x/version");
    expect(await checkTicket(ticket)).toMatchObject({ status: "working", finishing: true });
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
    const first = await waitingStep("deploy:fly", { whenRunning: "join" });
    try {
      const again = await waitingStep("deploy:fly", { whenRunning: "join" });
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

  it("a step stopped for a newer one takes what it started with it (a tunnel left open is public)", async () => {
    const sidecar = sidecarFile();
    const older = await waitingStep("add:slack:dev:/a", { sidecar });
    const started = Number(readFileSync(sidecar, "utf8"));
    expect(running(started)).toBe(true);
    const newer = await waitingStep("add:slack:dev:/a");
    try {
      expect(running(older.pid)).toBe(false);
      // Asked to stop first, so it can let go of what it holds; stopped regardless once it does not.
      expect(existsSync(`${sidecar}.term`)).toBe(true);
      await vi.waitFor(() => expect(running(started)).toBe(false));
    } finally {
      if (running(newer.pid)) process.kill(newer.pid as number);
      if (running(started)) process.kill(started, "SIGKILL");
    }
  });

  it("a step finishing what its person did is never stopped halfway: a newer attempt is answered with it", async () => {
    const atWork = await waitingStep("add:slack:dev:/b", { status: "working", finishing: true });
    try {
      const again = await waitingStep("add:slack:dev:/b");
      expect(again.ticket).toBe(atWork.ticket);
      expect(running(atWork.pid)).toBe(true);
    } finally {
      if (running(atWork.pid)) process.kill(atWork.pid as number);
    }
  });

  it("a step still getting ready (a box that does not answer) is replaced: a newer attempt is never locked out", async () => {
    const hung = await waitingStep("login:openai", { status: "working" });
    const newer = await waitingStep("login:openai");
    try {
      expect(newer.ticket).not.toBe(hung.ticket);
      expect(running(hung.pid)).toBe(false);
      expect(await checkTicket(hung.ticket)).toMatchObject({
        status: "failed",
        message: "replaced by a newer attempt to sign in to OpenAI",
      });
    } finally {
      if (running(newer.pid)) process.kill(newer.pid as number);
    }
  });

  it("a step's process that expires with its run still waiting takes what that run started with it", async () => {
    const sidecar = sidecarFile();
    const ticketModule = fileURLToPath(new URL("../src/cli/ticket.ts", import.meta.url));
    const runs = `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { runTicket } from ${JSON.stringify(ticketModule)};
      await runTicket(process.argv.at(-1), async () => {
        writeFileSync(${JSON.stringify(sidecar)}, String(spawn("sleep", ["60"], { stdio: "ignore" }).pid));
        return new Promise(() => {});
      });
      process.exit(0);`;
    const { ticket } = await startTicket({
      ...request("add:feishu:dev:/c", 2),
      waitsFirst: false,
      whenRunning: "replace",
      command: { file: process.execPath, args: ["--input-type=module", "-e", runs, "--"], cwd: tmpdir() },
    });
    await vi.waitFor(() => expect(existsSync(sidecar)).toBe(true), { timeout: 10_000 });
    const started = Number(readFileSync(sidecar, "utf8"));
    await vi.waitFor(async () => expect(await checkTicket(ticket)).toMatchObject({ status: "expired" }), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(running(started)).toBe(false), { timeout: 10_000 });
  });

  it("a step given up on for giving the person nothing to do is stopped first, so it writes nothing after", async () => {
    const sidecar = join(mkdtempSync(join(tmpdir(), "fa-ticket-pid-")), "pid");
    // It takes its ticket, then shows the person nothing.
    const silent = `
      const { readFileSync, writeFileSync } = require("node:fs");
      const path = require("node:path").join(process.env.HOME, ".fastagent", ".state", "tickets", process.argv.at(-1) + ".json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), status: "working", pid: process.pid }));
      writeFileSync(${JSON.stringify(sidecar)}, String(process.pid));
      setInterval(() => {}, 1000);`;
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

  it("a step that never takes its ticket within the start window is stopped and failed, whatever it may do", async () => {
    const sidecar = join(mkdtempSync(join(tmpdir(), "fa-ticket-pid-")), "pid");
    const busy = `require("node:fs").writeFileSync(${JSON.stringify(sidecar)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const given = await startTicket({
      ...request("add:lark"),
      waitsFirst: false,
      whenRunning: "replace",
      command: { file: process.execPath, args: ["-e", busy, "--"], cwd: tmpdir() },
      startTimeoutMs: 1_000,
    });
    expect(given).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/^it did not start within 1s: /),
    });
    // Stopped first: a step left running past a failed ticket would write nowhere and hold what it holds.
    const pid = existsSync(sidecar) ? Number(readFileSync(sidecar, "utf8")) : undefined;
    expect(running(pid)).toBe(false);
  });

  it("a step that takes a ticket already ended does not run: it is not this process's any more", async () => {
    const { ticket } = createTicket(request("add:lark"));
    // Given up on by the starting command before this process got to it.
    expect(await checkTicket(ticket)).toMatchObject({ status: "failed" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(async () => ({}));
    await runTicket(ticket, run);
    expect(run).not.toHaveBeenCalled();
    expect(await checkTicket(ticket)).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/^it stopped/),
    });
  });

  it("each step the person is waited on replaces the last one's fields; one that lapses first sets expires_in", async () => {
    const { ticket } = createTicket(request("add:slack", 900));
    const steer = steered();
    const running = runTicket(ticket, steer.run);
    const step = await steer.step;
    step.waits({ url: "https://t.example/tokens", code: "AB", takesAddress: true });
    step.person.carriesOn();
    step.person.waitsOn("https://slack.com/oauth", "click Allow", Date.now() + 120_000);
    const waiting = (await checkTicket(ticket)) as Ticket;
    expect(waiting).toMatchObject({ url: "https://slack.com/oauth", instructions: "click Allow" });
    expect(waiting).not.toHaveProperty("code");
    expect(waiting).not.toHaveProperty("takesAddress");
    // Waiting on the person again: replaceable again, its finished part kept in the state it wrote.
    expect(waiting).not.toHaveProperty("finishing");
    expect(ticketReport(waiting, "checked").json.expires_in).toBeLessThanOrEqual(120);
    steer.finish();
    await running;
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
    // What it reached before it failed is still the person's: where to get the value it stopped for.
    const reached = { instructions: "copy the Verification Token", url: "https://open.larksuite.com/app/cli/event" };
    expect(
      ticketReport(
        { ...base, status: "failed", message: "LARK_VERIFICATION_TOKEN is needed", afterwards: [reached] },
        "checked",
      ).json,
    ).toMatchObject({
      afterwards: [reached],
      agent_next_steps:
        "Tell the user what the steps it reached leave them: copy the Verification Token " +
        "https://open.larksuite.com/app/cli/event To try again, run: fastagent login openai --method account --json",
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
