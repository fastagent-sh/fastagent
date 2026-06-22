import { describe, expect, it } from "vitest";
// Internal module (not a public export): the execution-lifetime helper the channels build on.
import { createTrackedBackground } from "../src/channels/background.ts";

describe("createTrackedBackground", () => {
  it("starts the task on a macrotask so the caller's response lands first", async () => {
    const order: string[] = [];
    const { background, drain } = createTrackedBackground();
    background(async () => {
      order.push("task");
    });
    order.push("after-background"); // synchronous code after background() returns
    await Promise.resolve(); // a microtask (stands in for the response write) must run before the task
    order.push("microtask");
    await drain();
    expect(order).toEqual(["after-background", "microtask", "task"]);
  });

  it("runs tasks and drain() awaits in-flight work", async () => {
    const { background, drain } = createTrackedBackground();
    let done = false;
    background(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    expect(done).toBe(false); // not awaited synchronously
    await drain();
    expect(done).toBe(true);
  });

  it("a throwing task is surfaced via onTaskError and does not wedge drain", async () => {
    const errors: unknown[] = [];
    const { background, drain } = createTrackedBackground({ onTaskError: (e) => errors.push(e) });
    background(async () => {
      throw new Error("task boom");
    });
    await expect(drain()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("task boom");
  });

  it("a synchronously-thrown task is captured (not propagated out of background) and tracked", async () => {
    const errors: unknown[] = [];
    const { background, drain } = createTrackedBackground({ onTaskError: (e) => errors.push(e) });
    const syncThrow = (() => {
      throw new Error("sync boom");
    }) as () => Promise<void>;
    expect(() => background(syncThrow)).not.toThrow();
    await expect(drain()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("sync boom");
  });
});
