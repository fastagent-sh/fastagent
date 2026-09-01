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
import { saveFires } from "../../src/schedule/state.ts";
import { startSchedules } from "../../src/service.ts";
import { requireEnv } from "./env.ts";

// Node's fetch ignores HTTPS_PROXY; the library opener deliberately leaves this to its caller.
installProxyFetch();

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
const SCHEDULE = "heartbeat";
const BUDGET_MS = 480_000;

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
    // A plain default export: `defineSchedule` is an identity function, so this is the shape the
    // loader gets either way, and the file stays what an author's `schedules/*.ts` looks like rather
    // than carrying an import path back into this checkout (the spelling schedule-discover.test.ts
    // needs, since that one is testing the loader itself).
    await writeFile(
      join(dir, "schedules", `${SCHEDULE}.ts`),
      `export default { cron: "* * * * *", prompt: "Reply with just: tick" };\n`,
    );

    const { agent, stateRoot } = await createPiAgentFromDir(dir, { serving: true });

    // Two minutes back, seeded before the scheduler starts: the next 1-minute slot after it is already
    // in the past, so start() catches up instead of arming a timer.
    saveFires(stateRoot, { [SCHEDULE]: new Date(Date.now() - 120_000).toISOString() });

    // The entry `dev`/`start` take — discovery, failure reporting, createScheduler, start() — rather
    // than those four steps rebuilt here, which would measure the rebuild.
    const { schedules, stop } = await startSchedules(dir, agent, stateRoot, false);
    cleanups.push(stop);
    expect(
      schedules.map((s) => s.name),
      "the schedules/ file did not load",
    ).toEqual([SCHEDULE]);

    // The fire is a real model turn; poll the audit log rather than guessing a duration. The budget is
    // the file timeout minus room for teardown, not an estimate of a turn: a queued or thinking model
    // running long is the one thing this must not report as a schedule that never fired.
    let runs = readRuns(stateRoot, SCHEDULE);
    for (let waited = 0; runs.length === 0 && waited < BUDGET_MS; waited += 500) {
      await sleep(500);
      runs = readRuns(stateRoot, SCHEDULE);
    }

    expect(
      runs,
      `no run recorded in ${BUDGET_MS / 1000}s: the schedule never fired, or its turn is still running`,
    ).toHaveLength(1);
    // toMatchObject: a `failed` record carries `error`, and printing it is the difference between
    // knowing why an unattended nightly went red and having to re-run it.
    expect(runs[0]).toMatchObject({ name: SCHEDULE, outcome: "completed" });
    // toBeTruthy, not `.not.toBe("")`: a MISSING reply is exactly the regression this guards, and
    // `undefined?.trim()` is undefined, which is not "".
    expect(runs[0]?.reply?.trim(), "a completed run must carry the turn's reply").toBeTruthy();
    // The session is derived from the schedule's name, not minted per fire — that is what makes a
    // schedule's turns one continuing conversation.
    expect(runs[0]?.session).toContain(SCHEDULE);
  });
});
