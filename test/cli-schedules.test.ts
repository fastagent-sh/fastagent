import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveStateRoot } from "../src/paths.ts";
import { addWakeup, listWakeups } from "../src/schedule/wakeups.ts";
import { agentWorkspace, fauxAgent as agent, killWhileLingering, lingered, run, whileServed } from "./cli-run.ts";

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

const scheduleOf = (prompt: string) =>
  `export default { kind: "fastagent.schedule", cron: "0 9 * * *", prompt: ${JSON.stringify(prompt)} };\n`;
const SCHEDULE = scheduleOf("write the digest");

describe("cli: schedules run and unwake", () => {
  it("schedules run fires a schedule in its own session with its claim recorded, and only when no serve runs", async () => {
    const dir = await agent("fa-schedules-run-", { "src/schedules/digest.ts": SCHEDULE });
    const refused = await whileServed(dir, () => run(["schedules", "run", "digest", dir]));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("another `fastagent dev`, `start` or `schedules` command of this agent");

    // A fire a stopped serve claimed and never reported is accounted for first, as a serve's boot does.
    const claims = join(resolveStateRoot(dir), "schedule", "claims", "digest");
    await mkdir(claims, { recursive: true });
    await writeFile(join(claims, "2026-01-01T09-00-00-000Z"), JSON.stringify({ firedAt: "2026-01-01T09:00:00.000Z" }));

    const first = await run(["schedules", "run", "digest", dir]);
    expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
    const second = await run(["schedules", "run", "digest", dir]);
    expect([second.code, second.stdout.trim()], second.stderr).toEqual([0, "seen 2"]);
    const listed = JSON.parse((await run(["schedules", "list", "--json", dir])).stdout) as {
      schedules: { name: string; session: string | null; fires: { outcome?: string }[] }[];
    };
    expect(listed.schedules[0]?.session).toEqual(expect.any(String));
    expect(listed.schedules[0]?.fires.map((fire) => fire.outcome)).toEqual(["interrupted", "completed", "completed"]);

    const unknown = await run(["schedules", "run", "weekly", dir]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/no schedule "weekly" in .*src\/schedules\/ \(declared: digest\)/);
  });

  it("schedules run exits 1 on a cut-off answer, and refuses work a stopped process left unfinished", async () => {
    const dir = await agent("fa-schedules-unfinished-", {
      "src/schedules/clipped.ts": scheduleOf("cut it short"),
      "src/schedules/slow.ts": scheduleOf("linger over it"),
    });
    // The claim counts a cut-off answer as completed; a check does not.
    const clipped = await run(["schedules", "run", "clipped", dir]);
    expect([clipped.code, clipped.stdout.trim()], clipped.stderr).toEqual([1, "cut sho"]);
    expect(clipped.stderr).toContain("clipped: its answer was cut off (incomplete)");

    await killWhileLingering(["schedules", "run", "slow", dir], dir);
    const refused = await run(["schedules", "run", "clipped", dir]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/the storage holds 1 message\(s\) an earlier process accepted and stopped before/);
    expect(await lingered(dir)).toBe(1);
  });

  it("schedules unwake cancels a wake-up whatever session set it, and only when no serve runs", async () => {
    const dir = await agent("fa-schedules-unwake-");
    const stateRoot = resolveStateRoot(dir);
    const added = addWakeup(stateRoot, { session: "a schedule's own", prompt: "check", cron: "0 * * * *" });
    if (!added.ok) throw new Error(added.error);

    const refused = await whileServed(dir, () => run(["schedules", "unwake", added.id, dir]));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("is held by another process");
    expect(listWakeups(stateRoot).map((w) => w.id)).toEqual([added.id]);

    const removed = await run(["schedules", "unwake", added.id, dir]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain(`removed wake ${added.id}`);
    expect(listWakeups(stateRoot)).toEqual([]);
    const again = await run(["schedules", "unwake", added.id, dir]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`no pending wake-up ${added.id}`);
  });
});
