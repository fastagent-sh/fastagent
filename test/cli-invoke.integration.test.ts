import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { resolveStateRoot } from "../src/paths.ts";
import { fauxAgent as agent, killWhileLingering, lingered, runInProcess } from "./cli-run.ts";

describe("cli: invoke", () => {
  it("ends the message a killed invoke left, so no later invoke runs it again", async () => {
    const dir = await agent("fa-invoke-killed-");
    await killWhileLingering(["invoke", "linger, then deploy to prod", dir], dir);
    const next = await runInProcess(["invoke", "hello", dir]);
    expect([next.code, next.stdout.trim()], next.stderr).toEqual([0, "seen 1"]);
    expect(next.stderr).toMatch(/aborted 1 message\(s\) an earlier process accepted and stopped before they ended/);
    expect((await runInProcess(["invoke", "hello again", dir])).stderr).not.toContain("aborted");
    expect(await lingered(dir)).toBe(1);
  });

  it("refuses to run while another invoke holds the storage", async () => {
    const dir = await agent("fa-invoke-busy-");
    const held = await openLockedStorage(join(resolveStateRoot(dir), "invoke.sqlite"), "posix", "the test");
    try {
      const busy = await runInProcess(["invoke", "hello", dir]);
      expect(busy.code).toBe(1);
      expect(busy.stderr).toContain("another `fastagent invoke` of this agent is running");
    } finally {
      await held.close(BACKGROUND_CONTEXT);
    }
  });
});
