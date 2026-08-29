import { describe, expect, it } from "vitest";
import { activeWork, beginWork } from "../src/channels/busy.ts";
import { createTaskTracker } from "../src/channels/kit/tasks.ts";
import { createTurnQueue } from "../src/channels/kit/turn-queue.ts";

/** Wait until `cond` holds (settlement callbacks run on the microtask queue). */
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("channels/busy: the process-wide in-flight signal", () => {
  it("counts begin → done, and done is idempotent", () => {
    const base = activeWork();
    const done = beginWork();
    expect(activeWork()).toBe(base + 1);
    done();
    expect(activeWork()).toBe(base);
    done(); // settled twice (finally + catch cleanup paths) — must not go negative
    expect(activeWork()).toBe(base);
  });

  it("a turn accepted onto the queue reads busy from acceptance until its run settles", async () => {
    const base = activeWork();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const queue = createTurnQueue<{ session: string }>({ label: "[test]", run: () => gate });
    queue.accept({ session: "s" });
    expect(activeWork()).toBe(base + 1); // queued/running both count — the process must not idle
    release();
    await queue.idle();
    await until(() => activeWork() === base);
    expect(activeWork()).toBe(base);
  });

  it("a QUEUED turn behind an active one also counts (two accepted = two units)", async () => {
    const base = activeWork();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const queue = createTurnQueue<{ session: string }>({ label: "[test]", run: () => gate });
    queue.accept({ session: "s" });
    queue.accept({ session: "s" });
    expect(activeWork()).toBe(base + 2);
    release();
    await queue.idle();
    await until(() => activeWork() === base);
    expect(activeWork()).toBe(base);
  });

  it("a tracked side task counts until it settles — rejection included", async () => {
    const base = activeWork();
    const tracker = createTaskTracker("[test]");
    let reject: (e: Error) => void = () => {};
    const task = new Promise<void>((_r, rj) => {
      reject = rj;
    });
    tracker.track(task.catch(() => {})); // the caller owns the error (tasks.ts contract)
    expect(activeWork()).toBe(base + 1);
    reject(new Error("boom"));
    await tracker.drain();
    await until(() => activeWork() === base);
    expect(activeWork()).toBe(base);
  });
});
