import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentWorkspace, run } from "./cli-run.ts";

describe("a channel at the command line: the program by `add`, the app by `channels setup`", () => {
  it("channels setup lark with no one at a terminal: the App ID and Secret are pasted on a page of the setup's own, never typed into a file", async () => {
    const dir = await agentWorkspace("fa-add-lark-", {
      "package.json": JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "*" } }),
    });
    const home = await mkdtemp(join(tmpdir(), "fa-add-lark-home-"));
    const result = await run(["channels", "setup", "lark", dir, "--json"], undefined, { ...process.env, HOME: home });
    const report = JSON.parse(result.stdout);
    try {
      expect(result.code).toBe(0);
      expect(report).toMatchObject({
        status: "need_user_action",
        // A page on this machine: the browser sends the pair to this process, not through the agent's conversation.
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/setup\/[0-9a-f]{48}$/),
        instructions: expect.stringContaining("App ID and App Secret"),
        check_command: expect.stringContaining("channels setup lark --check"),
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
});
