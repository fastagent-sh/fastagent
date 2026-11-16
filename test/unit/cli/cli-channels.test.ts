import { describe, expect, it } from "vitest";
import { agentWorkspace, runInProcess } from "../../doubles/cli-run.ts";

describe("cli: channels setup", () => {
  it("rejects an unknown channel with exit 2, and returns the missing steps under --json", async () => {
    const dir = await agentWorkspace("fa-channels-setup-");

    const bad = await runInProcess(["channels", "setup", "nope", dir]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("`channels setup` sets up telegram, slack, feishu and lark");

    const setup = await runInProcess(["channels", "setup", "lark", dir, "--json"]);
    expect(setup.code, setup.stderr).toBe(2);
    expect(JSON.parse(setup.stdout)).toMatchObject({
      status: "need_user_action",
      channel: "lark",
      steps: [
        {
          fields: [
            { name: "LARK_APP_ID", secret: false },
            { name: "LARK_APP_SECRET", secret: true },
          ],
        },
      ],
    });
  });
});
