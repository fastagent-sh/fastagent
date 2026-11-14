import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentWorkspace, runInProcess } from "../../doubles/cli-run.ts";

describe("a channel at the command line: the program by `add`, the app by `channels setup`", () => {
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
      // Feishu and Lark open their WebSocket through an optional peer, so `add` declares it for `npm install`.
      const dependencies = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies;
      if (kind === "feishu" || kind === "lark") {
        expect(dependencies["@larksuiteoapi/node-sdk"]).toMatch(/^\^\d/);
        expect(outcome.next_steps[0]).toContain("installs @larksuiteoapi/node-sdk");
      } else {
        expect(dependencies).toEqual({ "@fastagent-sh/fastagent": "*" });
      }

      // The flags that were the app's setup are gone.
      for (const flag of ["--ingress webhook", "--env production", "--no-onboard", "--replace-config"]) {
        const refused = await runInProcess(["add", kind, dir, ...flag.split(" ")]);
        expect(refused.code, flag).toBe(2);
        expect(refused.stderr).toContain("unknown option");
      }
    },
  );

  it("`channels setup` rejects unknown channels with exit 2 and returns structured missing steps under --json", async () => {
    const dir = await agentWorkspace("fa-channels-setup-", {
      "package.json": JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "*" } }),
    });
    expect((await runInProcess(["add", "lark", dir, "--json"])).code).toBe(0);

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

  it("keeps an existing @larksuiteoapi/node-sdk range on re-add and refuses a missing manifest cleanly", async () => {
    const dir = await agentWorkspace("fa-add-feishu-idempotent-", {
      "package.json": JSON.stringify({
        type: "module",
        dependencies: { "@fastagent-sh/fastagent": "*", "@larksuiteoapi/node-sdk": "1.0.0" },
      }),
    });
    const first = await runInProcess(["add", "feishu", dir, "--json"]);
    expect(first.code, first.stderr).toBe(0);
    const firstOut = JSON.parse(first.stdout) as { next_steps: string[] };
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["@larksuiteoapi/node-sdk"]).toBe(
      "1.0.0",
    );
    expect(firstOut.next_steps[0]).toContain("if @fastagent-sh/fastagent is not installed yet");

    const second = await runInProcess(["add", "feishu", dir, "--json"]);
    expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["@larksuiteoapi/node-sdk"]).toBe(
      "1.0.0",
    );

    rmSync(join(dir, "package.json"));
    const missing = await runInProcess(["add", "feishu", dir]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no package.json");
  });
});
