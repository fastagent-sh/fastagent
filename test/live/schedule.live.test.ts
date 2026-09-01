/**
 * A schedule on disk fires a real turn and lands in the audit log — the whole chain, once, on a real
 * model. Offline the pieces are covered separately and each against fakes: discovery reads a directory
 * (schedule-discover.test.ts), the scheduler arms and claims against a fake clock
 * (scheduler.test.ts), the audit appends a record (schedule-audit.test.ts). Nothing joins them, so a
 * seam between two of them — a schedule that loads but never reaches the agent, a fire whose outcome
 * never reaches `runs.jsonl` — is invisible to all three.
 *
 * The fire comes from the catch-up branch: `start()` anchors a never-fired schedule on `now` (so a new
 * schedule cannot back-fire), which would mean waiting out a real cron instant. Seeding one past fire
 * makes the next slot already due, so the probe exercises catch-up — a real behaviour worth asserting
 * — instead of sleeping through a minute. The cron stays the documented 5-field form.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPiAgentFromDir } from "../../src/engines/pi/open.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { readRuns } from "../../src/schedule/audit.ts";
import { loadSchedules } from "../../src/schedule/discover.ts";
import { createScheduler } from "../../src/schedule/scheduler.ts";
import { saveFires } from "../../src/schedule/state.ts";
import { requireEnv } from "./env.ts";

// Node's fetch ignores HTTPS_PROXY; the library opener deliberately leaves this to its caller.
installProxyFetch();

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
const SCHEDULE = "heartbeat";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("schedules: a cron fire reaches the agent and the audit log", () => {
  it("catches up an overdue slot, runs the turn, and records the outcome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-live-schedule-"));
    await writeFile(join(dir, "persona.md"), "You are terse. Answer in as few words as possible.\n");
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: ${JSON.stringify(MODEL)} };\n`);
    await mkdir(join(dir, "schedules"), { recursive: true });
    // A plain default export, not `defineSchedule(...)`: that import resolves through the agent dir's
    // own node_modules, which a throwaway directory has none of (and vitest's alias does not reach a
    // dynamic import). `defineSchedule` is an identity function, so the loaded shape is the same one
    // either spelling produces. What that costs this probe is the module-resolution step, which is
    // covered where it belongs — registry.live.test.ts asserts the scaffold that carries the dependency.
    await writeFile(
      join(dir, "schedules", `${SCHEDULE}.ts`),
      `export default { cron: "* * * * *", prompt: "Reply with just: tick" };\n`,
    );

    const { agent, stateRoot } = await createPiAgentFromDir(dir, { serving: true });
    const { schedules, failures } = await loadSchedules(dir);
    expect(failures, "a schedules/ file failed to load").toEqual([]);
    expect(schedules.map((s) => s.name)).toEqual([SCHEDULE]);

    // Two minutes back: the next 1-minute slot after it is already in the past, so start() catches up
    // instead of arming a timer.
    saveFires(stateRoot, { [SCHEDULE]: new Date(Date.now() - 120_000).toISOString() });

    const scheduler = createScheduler({ agent, stateRoot, schedules });
    cleanups.push(() => scheduler.stop());
    scheduler.start();

    // The fire is a real model turn; poll the audit log rather than guessing a duration.
    let runs = readRuns(stateRoot, SCHEDULE);
    for (let waited = 0; runs.length === 0 && waited < 120_000; waited += 500) {
      await sleep(500);
      runs = readRuns(stateRoot, SCHEDULE);
    }

    expect(runs, "the overdue schedule never fired").toHaveLength(1);
    // toMatchObject: a `failed` record carries `error`, and printing it is the difference between
    // knowing why an unattended nightly went red and having to re-run it.
    expect(runs[0]).toMatchObject({ name: SCHEDULE, outcome: "completed" });
    expect(runs[0]?.reply?.trim(), "a completed run must carry the turn's reply").not.toBe("");
    // The session is derived from the schedule's name, not minted per fire — that is what makes a
    // schedule's turns one continuing conversation.
    expect(runs[0]?.session).toContain(SCHEDULE);
  });
});
