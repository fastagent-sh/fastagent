import { describe, expect, it } from "vitest";
import { fauxAgent as agent, killWhileLingering, lingered, runInProcess } from "./cli-run.ts";

const scheduleOf = (prompt: string) =>
  `export default { kind: "fastagent.schedule", cron: "0 9 * * *", prompt: ${JSON.stringify(prompt)} };\n`;

describe("cli: schedules run and unwake", () => {
  it("schedules run exits 1 on a cut-off answer, and refuses work a stopped process left unfinished", async () => {
    const dir = await agent("fa-schedules-unfinished-", {
      "src/schedules/clipped.ts": scheduleOf("cut it short"),
      "src/schedules/slow.ts": scheduleOf("linger over it"),
    });
    // The claim counts a cut-off answer as completed; a check does not.
    const clipped = await runInProcess(["schedules", "run", "clipped", dir]);
    expect([clipped.code, clipped.stdout.trim()], clipped.stderr).toEqual([1, "cut sho"]);
    expect(clipped.stderr).toContain("clipped: its answer was cut off (incomplete)");

    await killWhileLingering(["schedules", "run", "slow", dir], dir);
    const refused = await runInProcess(["schedules", "run", "clipped", dir]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/the storage holds 1 message\(s\) an earlier process accepted and stopped before/);
    expect(await lingered(dir)).toBe(1);
  });
});
