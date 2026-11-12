import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

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
