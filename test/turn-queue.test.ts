import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeWork } from "../src/channels/busy.ts";
import { type TurnQueue, createTurnQueue } from "../src/channels/kit/turn-queue.ts";
import { log } from "../src/log.ts";
import { portJoin } from "../src/effect-port.ts";

/** The consumer-side record for these tests: a `session` key plus caller-domain fields. */
interface Rec {
  id: string;
  session: string;
  payload: string;
}
const rec = (id: string, session = "s", payload = `p${id}`): Rec => ({ id, session, payload });

afterEach(() => vi.restoreAllMocks());

/** Wait until `cond` holds (turns run async on the session chains). */
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

const makeQueue = (run: (r: Rec) => Promise<void>, onQueuedBehind?: (r: Rec) => void): TurnQueue<Rec> =>
  createTurnQueue<Rec>({ label: "[test]", run: (rec) => portJoin(() => run(rec)), onQueuedBehind });

describe("turn-queue", () => {
  it("owns cleanup before the successor runs, counts queued work, and isolates sessions", async () => {
    const base = activeWork();
    const releasing = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const other = Promise.withResolvers<void>();
    const order: string[] = [];
    const queue = createTurnQueue<Rec>({
      label: "[test]",
      run: (r) =>
        Effect.gen(function* () {
          order.push(r.id);
          if (r.id === "1")
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                releasing.resolve();
                await released.promise;
                order.push("cleanup");
              }),
            );
          if (r.id === "3") other.resolve();
        }),
    });
    queue.accept(rec("1"));
    queue.accept(rec("2"));
    queue.accept(rec("3", "other"));
    expect(order).toEqual([]);
    expect(activeWork()).toBe(base + 3);
    const idle = queue.idle();
    try {
      await Promise.all([releasing.promise, other.promise]);
      expect(order).toEqual(["1", "3"]);
      expect(activeWork()).toBe(base + 2);
    } finally {
      released.resolve();
      await idle;
    }
    expect(order).toEqual(["1", "3", "cleanup", "2"]);
    expect(activeWork()).toBe(base);
  });

  it("a scope cleanup defect is diagnosed and the FIFO still advances", async () => {
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    const base = activeWork();
    const ran: string[] = [];
    const queue = createTurnQueue<Rec>({
      label: "[test]",
      run: (r) =>
        Effect.gen(function* () {
          ran.push(r.id);
          if (r.id === "1") yield* Effect.addFinalizer(() => Effect.die(new Error("cleanup broke")));
        }),
    });
    queue.accept(rec("1"));
    queue.accept(rec("2"));
    await queue.idle();
    expect(ran).toEqual(["1", "2"]);
    expect(activeWork()).toBe(base);
    expect(errors.mock.calls.flat().join(" ")).toContain("cleanup broke");
  });

  it("accept runs the turn", async () => {
    const ran: string[] = [];
    const queue = makeQueue(async (r) => {
      ran.push(r.payload);
    });
    queue.accept(rec("1"));
    await until(() => ran.length === 1);
    expect(ran).toEqual(["p1"]);
  });

  it("idle() resolves only after every in-flight turn has run to completion", async () => {
    // The deterministic drain the telegram test harness relies on: a gated turn keeps idle() pending;
    // releasing it lets idle() resolve. Without this, tests fall back to polling side effects (racy).
    const done: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const queue = makeQueue(async (r) => {
      await gate;
      done.push(r.id);
    });
    queue.accept(rec("1"));
    queue.accept(rec("2", "other")); // a different session runs concurrently; both gate on `gate`

    let settled = false;
    const idle = queue.idle().then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // turns are still parked — idle() must NOT have resolved

    release();
    await idle;
    expect(settled).toBe(true);
    expect(done.sort()).toEqual(["1", "2"]); // resolved only once both chains drained
  });

  it("idle() resolves immediately when the queue is empty", async () => {
    await expect(makeQueue(async () => {}).idle()).resolves.toBeUndefined();
  });

  it("serializes per session (FIFO) while different sessions run concurrently", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const queue = makeQueue(async (r) => {
      if (r.id === "1") await gate; // park the first turn of session A
      order.push(r.id);
    });
    queue.accept(rec("1", "A"));
    queue.accept(rec("2", "A")); // must wait behind 1
    queue.accept(rec("3", "B")); // different session — runs immediately
    await until(() => order.includes("3"));
    expect(order).toEqual(["3"]); // 2 is NOT running while 1 is parked
    releaseFirst();
    await until(() => order.length === 3);
    expect(order).toEqual(["3", "1", "2"]); // A's turns in arrival order
  });

  it("onQueuedBehind fires only when the session is already busy", async () => {
    const queuedBehind: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const done: string[] = [];
    const queue = makeQueue(
      async (r) => {
        if (r.id === "1") await gate;
        done.push(r.id);
      },
      (r) => queuedBehind.push(r.id),
    );
    queue.accept(rec("1"));
    expect(queuedBehind).toEqual([]); // idle session — no hook
    queue.accept(rec("2"));
    expect(queuedBehind).toEqual(["2"]); // busy — hook fired synchronously at accept
    release();
    await until(() => done.length === 2);
  });

  it("a runner rejection is logged, never an unhandled rejection — and the chain continues", async () => {
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    // Pin the "never unhandled" half of the name literally: collect any unhandled rejection during the
    // test window. (The chain-continues assertions below hold even WITHOUT the queue's catch —
    // `prev.then(task, task)` and the `finally` guarantee those — so they must not stand in for it.)
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const done: string[] = [];
      const queue = makeQueue(async (r) => {
        if (r.id === "1") throw new Error("runner escaped");
        done.push(r.id);
      });
      queue.accept(rec("1"));
      queue.accept(rec("2")); // same session — must still run after 1's rejection
      await until(() => done.length === 1);
      expect(done).toEqual(["2"]);
      // The discriminating assertions: the catch EXISTS and is LOUD — a silent `catch {}` regression
      // (exactly the fail-visibly violation this backstop prevents) turns this red.
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toMatch(/runner rejected.*runner escaped/);
      await new Promise((r) => setTimeout(r, 20)); // let Node surface any unhandled rejection
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
