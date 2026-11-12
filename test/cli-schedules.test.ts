import { addWakeup } from "../src/schedule/wakeups.ts";
import { describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveStateRoot } from "../src/paths.ts";
import { agentWorkspace, fauxAgent as agent, runInProcess } from "./cli-run.ts";

vi.mock("../src/harnesses/pi-durable/storage.ts", () => import("./storage-no-wait.ts"));

/** A schedule module as `defineSchedule` returns it, so the fixture needs no package of its own. */
const schedule = (cron: string, extra = "") =>
  `export default { kind: "fastagent.schedule", cron: ${JSON.stringify(cron)}${extra}, prompt: "go" };\n`;

describe("cli: schedules", () => {
  it("schedules list reads BOTH owners: the declared schedules and the agent's own pending wake-ups", async () => {
    // Cancelling a wake-up is the agent's (`unwake`). Reading one is not: without this, finding out why an agent
    // wakes at 3am means opening `<stateRoot>/schedule/wakeups.json` by hand.
    const dir = await agentWorkspace("fa-list-", {
      "src/schedules/daily.ts": schedule("0 9 * * *"),
      // A schedule whose code reads a secret this machine does not hold is listed all the same.
      "src/schedules/weekly.ts": `export default {
  kind: "fastagent.needs",
  secrets: [{ name: "FA_TEST_ABSENT", optional: false }],
  build: () => ({ kind: "fastagent.schedule", cron: "0 9 * * 1", tz: "Asia/Shanghai", prompt: "review" }),
};\n`,
    });
    const claims = join(dir, ".fastagent", "dev", ".state", "schedule", "claims", "daily");
    await mkdir(claims, { recursive: true });
    await writeFile(
      join(claims, "2026-01-01T09-00-00-000Z"),
      JSON.stringify({ firedAt: "2026-01-01T09:00:00.000Z", outcome: "failed", ms: 12 }),
    );
    const added = addWakeup(resolveStateRoot(dir), {
      session: "chat:42",
      prompt: "check the deploy",
      fireAt: new Date(Date.now() + 3_600_000),
    });
    if (!added.ok) throw new Error(added.error);

    const text = await runInProcess(["schedules", "list", dir]);
    expect(text.code).toBe(0);
    // When it runs next, how the last run ended, and the session its fires continue (none before the first).
    expect(text.stdout).toMatch(
      /daily\s+next \S+\s+cron 0 9 \* \* \*\s+last 2026-01-01T09:00:00.000Z failed\s+session=\(none yet\)/,
    );
    expect(text.stdout).toMatch(/weekly\s+next \S+\s+cron 0 9 \* \* 1 Asia\/Shanghai\s+never run/);
    expect(text.stdout).toContain(`wake ${added.id}`); // labelled — a different owner, not a schedule
    expect(text.stdout).toContain("session=chat:42");

    const asJson = await runInProcess(["schedules", "list", "--json", dir]);
    const parsed = JSON.parse(asJson.stdout) as {
      schedules: { name: string; session: string | null; fires: { outcome?: string }[] }[];
      wakeups: { id: string }[];
    };
    expect(parsed.schedules.map((s) => [s.name, s.session, s.fires.map((f) => f.outcome)])).toEqual([
      ["daily", null, ["failed"]],
      ["weekly", null, []],
    ]);
    expect(parsed.wakeups.map((w) => w.id)).toEqual([added.id]);
  });
});

const scheduleOf = (prompt: string) =>
  `export default { kind: "fastagent.schedule", cron: "0 9 * * *", prompt: ${JSON.stringify(prompt)} };\n`;
const SCHEDULE = scheduleOf("write the digest");

describe("cli: schedules run and unwake", () => {
  it("schedules run continues its session and records interrupted and completed claims", async () => {
    const dir = await agent("fa-schedules-run-", { "src/schedules/digest.ts": SCHEDULE });
    const claims = join(resolveStateRoot(dir), "schedule", "claims", "digest");
    await mkdir(claims, { recursive: true });
    await writeFile(join(claims, "2026-01-01T09-00-00-000Z"), JSON.stringify({ firedAt: "2026-01-01T09:00:00.000Z" }));

    const first = await runInProcess(["schedules", "run", "digest", dir]);
    expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
    const second = await runInProcess(["schedules", "run", "digest", dir]);
    expect([second.code, second.stdout.trim()], second.stderr).toEqual([0, "seen 2"]);
    const listed = JSON.parse((await runInProcess(["schedules", "list", "--json", dir])).stdout) as {
      schedules: { name: string; session: string | null; fires: { outcome?: string }[] }[];
    };
    expect(listed.schedules[0]?.session).toEqual(expect.any(String));
    expect(listed.schedules[0]?.fires.map((fire) => fire.outcome)).toEqual(["interrupted", "completed", "completed"]);
  });
});
