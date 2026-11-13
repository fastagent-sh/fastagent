import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

/**
 * What a setup with no one at a terminal asks `startTicket` to start. The step it starts serves the person a page of its
 * own (feishu-setup.test.ts and channels-setup.test.ts run that step in process).
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
