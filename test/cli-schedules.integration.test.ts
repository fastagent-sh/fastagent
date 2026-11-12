import { describe, expect, it } from "vitest";
import { resolveStateRoot } from "../src/paths.ts";
import { addWakeup, listWakeups } from "../src/schedule/wakeups.ts";
import { fauxAgent as agent, killWhileLingering, lingered, runInProcess, whileServed } from "./cli-run.ts";

const scheduleOf = (prompt: string) =>
  `export default { kind: "fastagent.schedule", cron: "0 9 * * *", prompt: ${JSON.stringify(prompt)} };\n`;
const SCHEDULE = scheduleOf("write the digest");

describe("cli: schedules run and unwake", () => {
  it("schedules run refuses to fire while a serve holds the storage", async () => {
    const dir = await agent("fa-schedules-busy-", { "src/schedules/digest.ts": SCHEDULE });
    const refused = await whileServed(dir, () => runInProcess(["schedules", "run", "digest", dir]));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("another `fastagent dev`, `start` or `schedules` command of this agent");
  });

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

  it("schedules unwake cancels a wake-up whatever session set it, and only when no serve runs", async () => {
    const dir = await agent("fa-schedules-unwake-");
    const stateRoot = resolveStateRoot(dir);
    const added = addWakeup(stateRoot, { session: "a schedule's own", prompt: "check", cron: "0 * * * *" });
    if (!added.ok) throw new Error(added.error);

    const refused = await whileServed(dir, () => runInProcess(["schedules", "unwake", added.id, dir]));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("is held by another process");
    expect(listWakeups(stateRoot).map((w) => w.id)).toEqual([added.id]);

    const removed = await runInProcess(["schedules", "unwake", added.id, dir]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain(`removed wake ${added.id}`);
    expect(listWakeups(stateRoot)).toEqual([]);
    const again = await runInProcess(["schedules", "unwake", added.id, dir]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`no pending wake-up ${added.id}`);
  });
});
