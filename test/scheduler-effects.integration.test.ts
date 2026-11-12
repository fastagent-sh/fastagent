import * as Effect from "effect/Effect";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { scriptedRun } from "./scripted-run.ts";
import { createScheduler } from "../src/schedule/scheduler.ts";
import { readFires, scheduleFile, writeScheduleFile } from "../src/schedule/state.ts";
import { listWakeups } from "../src/schedule/wakeups.ts";
import {
  NOW,
  hourly,
  freshRoot,
  seedFiredSlots,
  outcomes,
  lastFire,
  agentRunning,
} from "./scheduler-effects-fixtures.ts";

afterEach(() => vi.restoreAllMocks());

it("two SCHEDULERS over one state root fire a cron slot exactly once", async () => {
  // The reason this claim is atomic: `fires.json` was a read-modify-write, which two processes both won. Two
  // schedulers exist whenever a restart overlaps its predecessor, someone runs a second `start` on one directory, or
  // an external clock delivers while the resident one is armed — and a double fire is a real turn, billed twice.
  const stateRoot = await freshRoot();
  const source = new URL("../src/schedule/scheduler.ts", import.meta.url).href;
  const slot = "2026-07-07T10:00:00.000Z";
  const fire = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
          import * as Effect from "effect/Effect";
          const { fireScheduleOnce } = await import(${JSON.stringify(source)});
          const message = { id: "m", sessionId: "s", status: "completed" };
          const agent = {
            sessions: { async create() { return { id: "s" }; } },
            messages: {
              async send() {
                await new Promise((r) => setTimeout(r, 150));
                return message;
              },
              async get() { return message; },
            },
          };
          const outcome = await Effect.runPromise(fireScheduleOnce({
            agent,
            stateRoot: ${JSON.stringify(stateRoot)},
            schedule: { name: "job", cron: "0 * * * *", tz: "UTC", prompt: "go" },
            slot: new Date(${JSON.stringify(slot)}),
          }));
          process.send(outcome.fired ? "fired" : "skipped");
          `,
        ],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] },
      );
      child.on("message", (value) => resolve(String(value)));
      child.on("exit", (code) => reject(new Error(`child exited without an outcome (${code})`)));
    });

  const fired = await Promise.all([fire(), fire(), fire()]);
  expect(fired.filter((o) => o === "fired")).toHaveLength(1);
  expect(fired.filter((o) => o === "skipped")).toHaveLength(2);
  expect(outcomes(stateRoot)).toEqual(["completed"]); // one settled claim, so one billed turn
});

it.each(["cron", "one-shot", "recurring"] as const)(
  "SIGTERM preserves the claimed %s state without claiming the next wake",
  async (kind) => {
    const stateRoot = await freshRoot();
    const schedules = kind === "cron" ? [hourly()] : [];
    if (kind === "cron") seedFiredSlots(stateRoot, ["job"], "2026-07-07T08:00:00Z");
    else
      writeScheduleFile(scheduleFile(stateRoot, "wakeups"), [
        {
          id: "first",
          session: "first",
          prompt: "go",
          fireAt: "2026-07-07T09:00:00Z",
          ...(kind === "recurring" ? { cron: "0 * * * *", tz: "UTC" } : {}),
        },
        { id: "next", session: "next", prompt: "later", fireAt: "2026-07-07T09:00:00Z" },
      ]);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import * as Effect from "effect/Effect";
    const { createScheduler } = await import(process.argv[1]);
    const { stateRoot, schedules, now } = JSON.parse(process.argv[2]);
    process.on("message", () => {});
    const agent = {
      sessions: { async create() { return { id: "s" }; } },
      messages: { async send() { process.send("running"); await new Promise(() => {}); } },
    };
    Effect.runSync(createScheduler({ agent, stateRoot, schedules, now: () => new Date(now) })).start();
  `,
        new URL("../src/schedule/scheduler.ts", import.meta.url).href,
        JSON.stringify({ stateRoot, schedules, now: NOW.toISOString() }),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    const exited = once(child, "exit");
    try {
      expect(
        await Promise.race([
          once(child, "message").then(([value]) => value),
          exited.then(() => {
            throw new Error(`child exited before running: ${stderr}`);
          }),
        ]),
      ).toBe("running");
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
    // The killed turn wrote no outcome; its claim is simply unsettled, next to the seeded prior fire.
    expect(outcomes(stateRoot)).toEqual(kind === "cron" ? ["completed", undefined] : []);
    if (kind === "cron") expect(lastFire(stateRoot, "job")).toBe(NOW.toISOString());
    else {
      expect(listWakeups(stateRoot).map((w) => w.id)).toEqual(kind === "recurring" ? ["first", "next"] : ["next"]);
      if (kind === "recurring") expect(listWakeups(stateRoot)[0]?.fireAt).toBe("2026-07-07T11:00:00.000Z");
    }
    const { agent, sent } = agentRunning(async function* (request) {
      yield* scriptedRun(request);
    });
    const s = Effect.runSync(createScheduler({ agent, stateRoot, schedules, now: () => NOW }));
    try {
      s.start();
      await vi.waitFor(() => expect(sent()).toEqual(kind === "cron" ? [] : ["next"]));
      // The claim the killed process left is not replayed, and this boot puts it on the record. A wake-up has no
      // such claim to reconcile — it leaves the store before its turn starts, so the killed occurrence is simply
      // gone (`next` above is the SECOND wake-up, not a replay of the killed one).
      await vi.waitFor(() => expect(outcomes(stateRoot)).toEqual(kind === "cron" ? ["completed", "interrupted"] : []));
      if (kind === "cron") {
        expect(readFires(stateRoot, "job").at(-1)).toMatchObject({
          outcome: "interrupted",
          firedAt: NOW.toISOString(),
        });
      }
    } finally {
      s.stop();
    }
  },
);
