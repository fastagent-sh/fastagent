import { afterEach, describe, expect, it, vi } from "vitest";
import { type TurnQueue, createTurnQueue } from "../src/channels/telegram/turn-queue.ts";
import { log } from "../src/log.ts";

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
  createTurnQueue<Rec>({ label: "[test]", run, onQueuedBehind });

describe("turn-queue", () => {
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
