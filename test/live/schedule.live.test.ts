/**
 * A schedule on disk fires a real turn, reports it, and settles its claim — the whole chain, once, on a
 * real model. Offline the pieces are covered separately and each against fakes: discovery reads a
 * directory (schedule-discover.test.ts), the scheduler arms, claims and settles against a fake clock
 * (scheduler.test.ts). Nothing joins them, so a seam between two of them — a schedule that loads but
 * never reaches the agent, a fire whose outcome never reaches its claim — is invisible to both.
 *
 * The fire comes from the catch-up branch: `start()` anchors a never-fired schedule on `now` (so a new
 * schedule cannot back-fire), which would mean waiting out a real cron instant. Seeding one past fire
 * makes the next slot already due, so the probe exercises catch-up — a real behaviour worth asserting
 * — instead of sleeping through a minute. The cron stays the documented 5-field form.
 */
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPiAgentFromDir } from "../../src/engines/pi/open.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { claimSlot, type Fire, readFires } from "../../src/schedule/state.ts";
import { loadServingSchedules, startSchedules } from "../../src/service.ts";
import { requireEnv } from "./env.ts";

// Node's fetch ignores HTTPS_PROXY; the library opener deliberately leaves this to its caller.
installProxyFetch();

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
const SCHEDULE = "heartbeat";
/** The schedule's instruction. Removed from the journal, what is left can only be the model's own answer. */
const PROMPT = "Reply with just: tick";
const BUDGET_MS = 480_000;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("schedules: a cron fire reaches the agent, its session, and its claim", () => {
  it("catches up an overdue slot, runs the turn, and records the outcome", async () => {
    // The fire's own lines go to stderr, the way an operator reads them; what the turn SAID goes to the
    // session, which is the only place it is stored.
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    cleanups.push(() => vi.restoreAllMocks());
    const dir = await mkdtemp(join(tmpdir(), "fa-live-schedule-"));
    await writeFile(join(dir, "persona.md"), "You are terse. Answer in as few words as possible.\n");
    await writeFile(join(dir, "fastagent.config.ts"), `export default { model: ${JSON.stringify(MODEL)} };\n`);
    await mkdir(join(dir, "schedules"), { recursive: true });
    // A plain default export: `defineSchedule` is an identity function, so this is the shape the
    // loader gets either way, and the file stays what an author's `schedules/*.ts` looks like rather
    // than carrying an import path back into this checkout (the spelling schedule-discover.test.ts
    // needs, since that one is testing the loader itself).
    await writeFile(
      join(dir, "schedules", `${SCHEDULE}.ts`),
      `export default { cron: "* * * * *", prompt: ${JSON.stringify(PROMPT)} };\n`,
    );

    const { agent, stateRoot } = await createPiAgentFromDir(dir, { serving: true });

    // Two minutes back, seeded before the scheduler starts: the next 1-minute slot after it is already
    // in the past, so start() catches up instead of arming a timer.
    // A claim two minutes old: the catch-up start point, without pretending a slot was fired since.
    const seededAt = new Date(Date.now() - 120_000);
    claimSlot(stateRoot, SCHEDULE, seededAt, seededAt);

    // The entry `dev`/`start` take — discovery, failure reporting, createScheduler, start() — rather
    // than those four steps rebuilt here, which would measure the rebuild.
    const { schedules, stop } = startSchedules(agent, stateRoot, false, await loadServingSchedules(dir));
    cleanups.push(stop);
    expect(
      schedules.map((s) => s.name),
      "the schedules/ file did not load",
    ).toEqual([SCHEDULE]);

    // The seeded claim is reconciled first, and correctly: an unsettled claim IS a fire the process was killed in
    // the middle of (`markInterruptedFire`), and nothing distinguishes this one from a real one. So the record
    // under test is the CATCH-UP fire's, which carries a wall-clock `firedAt` later than the seed.
    //
    // The fire is a real model turn; poll the settled claim rather than guessing a duration. The budget
    // is the file timeout minus room for teardown, not an estimate of a turn: a queued or thinking
    // model running long is the one thing this must not report as a schedule that never fired.
    const settled = (): Fire[] =>
      readFires(stateRoot, SCHEDULE).filter(
        (f) => f.outcome !== undefined && Date.parse(f.firedAt) > seededAt.getTime(),
      );
    for (let waited = 0; settled().length === 0 && waited < BUDGET_MS; waited += 500) await sleep(500);

    const fires = settled();
    expect(
      fires,
      `no fire settled in ${BUDGET_MS / 1000}s: the schedule never fired, or its turn is still running`,
    ).toHaveLength(1);
    // The claim says how it ended, and WHY a failed one failed is in the log the same turn wrote — so both travel
    // IN the failure message: a bare matcher would print "expected 'failed' to be 'completed'" and leave the reason
    // in a log nobody kept, which is the difference between knowing why an unattended nightly went red and
    // re-running it.
    const seen = `${JSON.stringify(fires[0])}\n${logs.join("\n")}`;
    expect(fires[0]?.outcome, `the scheduled turn did not complete: ${seen}`).toBe("completed");
    // The session is derived from the schedule's name, not minted per fire — that is what makes a
    // schedule's turns one continuing conversation, and it is where the turn's text lives.
    expect(logs.join("\n")).toContain(`firing (session=schedule:${SCHEDULE})`);
    // The regression this guards is a completed turn that ANSWERED NOTHING: the claim would still say `completed`
    // while the conversation holds only the prompt. So the prompt is removed from the journal before looking for
    // the answer — asserting on text the scheduler itself wrote would pass with no model output at all.
    const sessionsDir = join(stateRoot, "sessions");
    const files = await readdir(sessionsDir, { recursive: true, withFileTypes: true });
    const journals = await Promise.all(
      files.filter((f) => f.isFile()).map((f) => readFile(join(f.parentPath, f.name), "utf8")),
    );
    const journal = journals.join("\n");
    expect(journal, `nothing was persisted under ${sessionsDir}`).toContain(PROMPT);
    const answered = journal.replaceAll(PROMPT, "");
    expect(answered, `the turn completed without answering: ${journal.slice(-2000)}`).toMatch(/tick/i);
  });
});
