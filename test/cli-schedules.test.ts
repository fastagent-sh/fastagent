import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace, run } from "./cli-run.ts";

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
    const claims = join(dir, ".state", "schedule", "claims", "daily");
    await mkdir(claims, { recursive: true });
    await writeFile(
      join(claims, "2026-01-01T09-00-00-000Z"),
      JSON.stringify({ firedAt: "2026-01-01T09:00:00.000Z", outcome: "failed", ms: 12 }),
    );
    const { addWakeup } = await import("../src/schedule/wakeups.ts");
    const { resolveStateRoot } = await import("../src/paths.ts");
    const added = addWakeup(resolveStateRoot(dir), {
      session: "chat:42",
      prompt: "check the deploy",
      fireAt: new Date(Date.now() + 3_600_000),
    });
    if (!added.ok) throw new Error(added.error);

    const text = await run(["schedules", "list", dir]);
    expect(text.code).toBe(0);
    // When it runs next, how the last run ended, and the session its fires continue (none before the first).
    expect(text.stdout).toMatch(
      /daily\s+next \S+\s+cron 0 9 \* \* \*\s+last 2026-01-01T09:00:00.000Z failed\s+session=\(none yet\)/,
    );
    expect(text.stdout).toMatch(/weekly\s+next \S+\s+cron 0 9 \* \* 1 Asia\/Shanghai\s+never run/);
    expect(text.stdout).toContain(`wake ${added.id}`); // labelled — a different owner, not a schedule
    expect(text.stdout).toContain("session=chat:42");

    const asJson = await run(["schedules", "list", "--json", dir]);
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

  it("schedules list says which file is not a schedule, and refuses unreadable state in one line", async () => {
    const broken = await agentWorkspace("fa-list-cron-", { "src/schedules/broken.ts": schedule("not a cron") });
    const refused = await run(["schedules", "list", broken]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/src\/schedules\/broken\.ts/);
    expect(refused.stderr).not.toMatch(/\n\s+at /);

    const dir = await agentWorkspace("fa-list-broken-", { "src/schedules/daily.ts": schedule("0 9 * * *") });

    // An OLD claim that cannot be read does not fail the text listing, which reads the newest only; the whole history
    // (`--json`) does say so.
    const claims = join(dir, ".state", "schedule", "claims", "daily");
    await mkdir(join(claims, "2026-01-01T09-00-00-000Z"), { recursive: true }); // a directory where a claim file goes
    await writeFile(
      join(claims, "2026-01-02T09-00-00-000Z"),
      JSON.stringify({ firedAt: "2026-01-02T09:00:00.000Z", outcome: "completed", ms: 5 }),
    );
    const textOnly = await run(["schedules", "list", dir]);
    expect(textOnly.code, textOnly.stderr).toBe(0);
    expect(textOnly.stdout).toMatch(/last 2026-01-02T09:00:00.000Z completed/);
    const history = await run(["schedules", "list", dir, "--json"]);
    expect(history.code).toBe(1);
    expect(history.stderr).toMatch(/the fire history of "daily" is unreadable/);
    await rm(claims, { recursive: true });

    // Unreadable state is the operator's to fix: a read-only command says so in one line rather than printing the
    // Node stack `readFires` throws for the serving boot's benefit.
    await mkdir(join(dir, ".state", "schedule", "claims"), { recursive: true });
    await writeFile(join(dir, ".state", "schedule", "claims", "daily"), ""); // a FILE where the dir goes
    const unreadable = await run(["schedules", "list", dir, "--json"]);
    expect(unreadable.code).toBe(1);
    expect(unreadable.stdout).toBe("");
    expect(unreadable.stderr).toMatch(/the fire history of "daily" is unreadable/);
    expect(unreadable.stderr).not.toMatch(/at listClaims/); // no stack
  });
});
