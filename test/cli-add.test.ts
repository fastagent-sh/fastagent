import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

/**
 * What a setup with no one at a terminal asks `startTicket` to start. The step it starts serves the person a page of its
 * own (feishu-setup.test.ts and channels-setup.test.ts run that step in process); that it outlives this command is
 * `startTicket`'s, tested with real processes in ticket.integration.test.ts.
 */
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
        url: "http://127.0.0.1:4242/setup/0123456789abcdef0123456789abcdef0123456789abcdef",
        instructions: "Paste the App ID and App Secret of the Lark app on this page.",
      };
    },
  };
});

afterEach(() => started.splice(0));

describe("a channel at the command line: the program by `add`, the app by `channels setup`", () => {
  it("a ticket that names no setup, or another command's, is a usage error naming the right command", async () => {
    const result = await runInProcess(["channels", "setup", "feishu", "--check", "0123456789abcdef", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`no ticket "0123456789abcdef" on this machine`);
    const { createTicket } = await import("../src/cli/ticket.ts");
    const signIn = createTicket({
      subject: "login:openai",
      action: "sign in to OpenAI",
      check: "fastagent login --check",
      restart: "fastagent login openai --method account",
      timeoutSeconds: 60,
      fields: { provider: "openai", method: "account" },
    }).ticket;
    const other = await runInProcess(["channels", "setup", "feishu", "--check", signIn, "--json"]);
    expect(other.code).toBe(2);
    expect(other.stderr).toContain(
      `ticket ${signIn} is not this command's: it is to sign in to OpenAI; check it with \`fastagent login --check ${signIn}\``,
    );
    // Its own command reads it (failed: no process ever ran it).
    const back = await runInProcess(["login", "--check", signIn, "--json"]);
    expect(JSON.parse(back.stdout)).toMatchObject({ provider: "openai", status: "failed" });
  });

  it("channels setup lark with no one at a terminal hands the setup to a ticket whose page takes the pair, never a file edit", async () => {
    const dir = await agentWorkspace("fa-add-lark-", {
      "package.json": JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "*" } }),
    });
    const result = await runInProcess(["channels", "setup", "lark", dir, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const [asked] = started as [Record<string, unknown> & { command: { args: string[] } }];
    expect(asked).toMatchObject({
      subject: expect.stringMatching(/^channels-setup:lark:/),
      action: "set up the lark app",
      check: "fastagent channels setup lark --check",
      waitsFirst: false,
      whenRunning: "replace",
    });
    expect(asked.command.args.slice(-4)).toEqual(["channels", "setup", "lark", dir]);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      status: "need_user_action",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/setup\/[0-9a-f]{48}$/),
      instructions: expect.stringContaining("App ID and App Secret"),
      check_command: expect.stringContaining("channels setup lark --check"),
    });
    // Nothing asks the person to edit a file, the way every secret reached a chat window before.
    expect(result.stdout).not.toContain("value_file");
  });

  it.each(["telegram", "slack", "feishu", "lark"] as const)(
    "%s changes the program only: the channel and its tools, the names it reads, no app and no value",
    async (kind) => {
      const dir = await agentWorkspace(`fa-add-${kind}-`, {
        "package.json": JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "*" } }),
      });
      const result = await runInProcess(["add", kind, dir, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      const outcome = JSON.parse(result.stdout) as { status: string; created: string[]; next_steps: string[] };
      expect(outcome.status).toBe("done");
      expect(outcome.created).toContain(join(dir, "src", "channels", `${kind}.ts`));
      expect(outcome.next_steps).toEqual(
        expect.arrayContaining([expect.stringContaining(`fastagent channels setup ${kind}`), "fastagent dev"]),
      );
      expect(existsSync(join(dir, "src", "channels", `${kind}.ts`))).toBe(true);
      // Asks nothing and writes no value: the instance's values are `channels setup`'s.
      expect(existsSync(join(dir, ".secrets", ".env"))).toBe(false);
      expect(outcome.next_steps.join("\n")).not.toContain("tunnel");

      // The flags that were the app's setup are gone.
      for (const flag of ["--ingress webhook", "--env production", "--no-onboard", "--replace-config"]) {
        const refused = await runInProcess(["add", kind, dir, ...flag.split(" ")]);
        expect(refused.code, flag).toBe(2);
        expect(refused.stderr).toContain("unknown option");
      }
    },
  );
});
