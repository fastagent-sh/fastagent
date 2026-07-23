import { describe, expect, it } from "vitest";
import { createTaskTracker } from "../src/channels/tasks.ts";

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
});
