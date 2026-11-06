import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentWorkspace, run, runInProcess } from "./cli-run.ts";

describe("add <channel> with no one at a terminal: the person's part, named", () => {
  it("lark: the App ID and Secret are pasted on a page of the setup's own, never typed into a file", async () => {
    const dir = await agentWorkspace("fa-add-lark-", {
      "package.json": JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "*" } }),
    });
    const home = await mkdtemp(join(tmpdir(), "fa-add-lark-home-"));
    const result = await run(["add", "lark", dir, "--json"], undefined, { ...process.env, HOME: home });
    const report = JSON.parse(result.stdout);
    try {
      expect(result.code).toBe(0);
      expect(report).toMatchObject({
        status: "need_user_action",
        // A page on this machine: the browser sends the pair to this process, not through the agent's conversation.
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/lark\/credentials\/[0-9a-f]{48}$/),
        instructions: expect.stringContaining("App ID and App Secret"),
        check_command: expect.stringContaining("add lark --check"),
      });
      // Nothing asks the person to edit a file, the way every secret reached a chat window before.
      expect(result.stdout).not.toContain("value_file");
      const page = await (await fetch(report.url)).text();
      expect(page).toContain("Connect Lark");
      // The app it sends them to create is created with the scopes and the event the channel needs.
      expect(page).toContain("backend_oneclick");
      expect(page).toContain("addons=");
      // Waiting for the pair: none has been written anywhere.
      expect(
        existsSync(join(dir, ".secrets", ".env")) ? await readFile(join(dir, ".secrets", ".env"), "utf8") : "",
      ).not.toContain("LARK_APP_ID=");
    } finally {
      // The ticket's own process holds the page open until the ticket ends: end it here.
      const stored = JSON.parse(
        await readFile(join(home, ".fastagent", ".state", "tickets", `${report.ticket}.json`), "utf8"),
      );
      try {
        process.kill(-stored.pid, "SIGTERM");
      } catch {
        // gone already
      }
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("a ticket that names no setup, or another command's, is a usage error naming the right command", async () => {
    const result = await runInProcess(["add", "feishu", "--check", "0123456789abcdef", "--json"]);
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
    const other = await runInProcess(["add", "feishu", "--check", signIn, "--json"]);
    expect(other.code).toBe(2);
    expect(other.stderr).toContain(
      `ticket ${signIn} is not this command's: it is to sign in to OpenAI; check it with \`fastagent login --check ${signIn}\``,
    );
    // Its own command reads it (failed: no process ever ran it).
    const back = await runInProcess(["login", "--check", signIn, "--json"]);
    expect(JSON.parse(back.stdout)).toMatchObject({ provider: "openai", status: "failed" });
  });

  it.each(["telegram", "slack"] as const)(
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
