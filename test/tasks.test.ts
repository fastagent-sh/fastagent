import { describe, expect, it } from "vitest";
import { createTaskTracker } from "../src/channels/kit/tasks.ts";

describe("createTaskTracker", () => {
  it("drain waits for tracked tasks; settled tasks drop out", async () => {
    const tracker = createTaskTracker();
    let done = false;
    let release!: () => void;
    tracker.track(
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        done = true;
      }),
    );
    const drain = tracker.drain();
    release();
    await drain;
    expect(done).toBe(true);
    await tracker.drain(); // empty after settle — drains immediately
  });

  it("a rejected (caller-handled) task still settles the drain", async () => {
    const tracker = createTaskTracker();
    tracker.track(Promise.reject(new Error("boom")).catch(() => "handled"));
    await expect(tracker.drain()).resolves.toBeUndefined();
  });

  it("drain SETTLES a task that rejects — a caller handling its error on a separate branch still", async () => {
    // `p.catch(log); track(p)` handles the error but hands us a promise that still rejects. Draining
    // must not turn that into a failed turnsIdle for the whole serve.
    const tracker = createTaskTracker();
    const task = Promise.reject(new Error("boom"));
    let handled: string | undefined;
    task.catch((error: Error) => {
      handled = error.message;
    });
    tracker.track(task);
    await expect(tracker.drain()).resolves.toBeUndefined();
    expect(handled).toBe("boom");
  });
});
