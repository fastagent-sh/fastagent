import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentWorkspace, run } from "./cli-run.ts";

describe("add <channel> with no one at a terminal: the person's part, named", () => {
  it("lark: the app's credentials are theirs to set in the value file, and nothing is written before them", async () => {
    const dir = await agentWorkspace("fa-add-lark-");
    const result = await run(["add", "lark", dir, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "need_user_action",
      url: "https://open.larksuite.com/page/launcher?from=backend_oneclick",
      variables: ["LARK_APP_ID", "LARK_APP_SECRET"],
      value_file: join(dir, ".secrets", ".env"),
      check_command: `fastagent add lark ${dir} --json`,
      agent_next_steps: expect.stringContaining("themselves, not in this conversation"),
    });
    expect(existsSync(join(dir, "src", "channels", "lark.ts"))).toBe(false);
  });

  it("a ticket that names no setup is a usage error", async () => {
    const result = await run(["add", "feishu", "--check", "0123456789abcdef", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`no setup "0123456789abcdef"`);
  });

  it("telegram has no person's part: it is added, the outcome one JSON object", async () => {
    const dir = await agentWorkspace("fa-add-telegram-", {
      "package.json": JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "*" } }),
    });
    const result = await run(["add", "telegram", dir, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "done",
      written: expect.arrayContaining(["TELEGRAM_SECRET_TOKEN"]),
      next_steps: expect.arrayContaining([expect.stringContaining("TELEGRAM_BOT_TOKEN")]),
    });
    expect(existsSync(join(dir, "src", "channels", "telegram.ts"))).toBe(true);
  });
});
