import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { resolveStateRoot } from "../src/paths.ts";
import { fauxAgent as agent, run, whileServed } from "./cli-run.ts";

describe("cli: invoke", () => {
  it("--session continues the conversation of that name beside a serve, and --json prints its events", async () => {
    const dir = await agent("fa-invoke-session-");
    await whileServed(dir, async () => {
      const first = await run(["invoke", "--session", "smoke", "hello", dir]);
      expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
      const second = await run(["invoke", "--session", "smoke", "again", dir]);
      expect([second.code, second.stdout.trim()], second.stderr).toEqual([0, "seen 2"]);
      // A continued conversation answers with the model this run names.
      expect((await run(["invoke", "--session", "smoke", "--model", "gw/m2", "and", dir])).stdout.trim()).toBe(
        "seen 3 by m2",
      );
      // Another name, or none, is a conversation of its own.
      expect((await run(["invoke", "--session", "other", "hello", dir])).stdout.trim()).toBe("seen 1");
      expect((await run(["invoke", "hello", dir])).stdout.trim()).toBe("seen 1");
      expect((await run(["invoke", "hello", dir])).stdout.trim()).toBe("seen 1");
    });

    const json = await run(["invoke", "--session", "smoke", "--json", "use a tool", dir]);
    expect(json.code, json.stderr).toBe(0);
    const lines = json.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; name?: string; message?: { outcome?: unknown } });
    expect(lines[0]).toMatchObject({ type: "receipt", duplicate: false, message: { messageId: expect.any(String) } });
    expect(lines.find((line) => line.type === "tool_started")).toMatchObject({ name: "read" });
    expect(lines.at(-1)).toMatchObject({ type: "done", message: { outcome: { status: "completed" } } });
  });

  it("refuses a --session name that is not a file name, and a conversation another invoke holds", async () => {
    const dir = await agent("fa-invoke-name-");
    const refused = await run(["invoke", "--session", "../escape", "hello", dir]);
    expect([refused.code, refused.stdout]).toEqual([2, ""]);
    expect(refused.stderr).toMatch(/--session "\.\.\/escape": a name of letters/);

    const file = join(resolveStateRoot(dir), "invoke", "busy.sqlite");
    const held = await openLockedStorage(file, "posix", "the test");
    try {
      const busy = await run(["invoke", "--session", "busy", "hello", dir]);
      expect(busy.code).toBe(1);
      expect(busy.stderr).toContain("another `fastagent invoke --session busy` of this agent is running");
    } finally {
      await held.close(BACKGROUND_CONTEXT);
    }
  });
});
