import { describe, expect, it } from "vitest";
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
});
