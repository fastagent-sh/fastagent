import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TurnRecord, type TurnStore, createTurnStore } from "../src/channels/telegram/turn-store.ts";
import { log } from "../src/log.ts";

/** The consumer-side record for these tests: one caller-domain field beyond the store's TurnRecord. */
interface Rec extends TurnRecord {
  payload: string;
  previewId?: number;
}
const isRec = (r: unknown): r is Rec =>
  typeof (r as Rec)?.id === "string" &&
  ((r as Rec).state === "queued" || (r as Rec).state === "started") &&
  typeof (r as Rec).session === "string" &&
  typeof (r as Rec).payload === "string";

const rec = (id: string, session = "s", payload = `p${id}`): Rec => ({ id, state: "queued", session, payload });

const dirs: string[] = [];
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "turn-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const walPath = (dir: string): string => join(dir, "queue.json");
const readWal = (dir: string): { pending: Rec[]; tombstones: string[] } =>
  JSON.parse(readFileSync(walPath(dir), "utf8")) as { pending: Rec[]; tombstones: string[] };

/** Wait until `cond` holds (turns run async on the session chains). */
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

const makeStore = (
  dir: string,
  run: (r: Rec, s: TurnStore<Rec>) => Promise<void>,
  onQueuedBehind?: (r: Rec, s: TurnStore<Rec>) => void,
): TurnStore<Rec> =>
  createTurnStore<Rec>({ path: walPath(dir), label: "[test]", isRecord: isRec, run, onQueuedBehind });

describe("turn-store", () => {
  it("accept runs the turn and drains it from the WAL", async () => {
    const dir = freshDir();
    const ran: string[] = [];
    const store = makeStore(dir, async (r, s) => {
      s.started(r.id);
      ran.push(r.payload);
    });
    store.accept(rec("1"));
    await until(() => ran.length === 1);
    expect(ran).toEqual(["p1"]);
    await until(() => readWal(dir).pending.length === 0);
  });

  it("serializes per session (FIFO) while different sessions run concurrently", async () => {
    const dir = freshDir();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const store = makeStore(dir, async (r) => {
      if (r.id === "1") await gate; // park the first turn of session A
      order.push(r.id);
    });
    store.accept(rec("1", "A"));
    store.accept(rec("2", "A")); // must wait behind 1
    store.accept(rec("3", "B")); // different session — runs immediately
    await until(() => order.includes("3"));
    expect(order).toEqual(["3"]); // 2 is NOT running while 1 is parked
    releaseFirst();
    await until(() => order.length === 3);
    expect(order).toEqual(["3", "1", "2"]); // A's turns in arrival order
  });

  it("onQueuedBehind fires only when the session is already busy", async () => {
    const dir = freshDir();
    const queuedBehind: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const done: string[] = [];
    const store = makeStore(
      dir,
      async (r) => {
        if (r.id === "1") await gate;
        done.push(r.id);
      },
      (r) => queuedBehind.push(r.id),
    );
    store.accept(rec("1"));
    expect(queuedBehind).toEqual([]); // idle session — no hook
    store.accept(rec("2"));
    expect(queuedBehind).toEqual(["2"]); // busy — hook fired synchronously at accept
    release();
    await until(() => done.length === 2);
  });

  it("recovery replays a queued record exactly once and tombstones it (redelivery suppressed)", async () => {
    const dir = freshDir();
    writeFileSync(walPath(dir), JSON.stringify({ pending: [rec("9")], tombstones: [] }));
    const ran: string[] = [];
    const store = makeStore(dir, async (r) => {
      ran.push(r.id);
    });
    expect(store.suppressed("9")).toBe(true); // tombstoned BEFORE the replay even settles
    await until(() => ran.length === 1);
    expect(ran).toEqual(["9"]);
    await until(() => readWal(dir).pending.length === 0);
    expect(readWal(dir).tombstones).toEqual(["9"]);
  });

  it("recovery DROPS a started record — it may already have answered — and tombstones it", async () => {
    const dir = freshDir();
    writeFileSync(walPath(dir), JSON.stringify({ pending: [{ ...rec("7"), state: "started" }], tombstones: [] }));
    const ran: string[] = [];
    const store = makeStore(dir, async (r) => {
      ran.push(r.id);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(ran).toEqual([]); // never replayed
    expect(store.suppressed("7")).toBe(true);
    expect(readWal(dir)).toEqual({ pending: [], tombstones: ["7"] }); // dropped record does not survive as pending
  });

  it("tombstones are bounded: the oldest is evicted past the cap", async () => {
    const dir = freshDir();
    const old = Array.from({ length: 50 }, (_, i) => `t${i}`);
    writeFileSync(walPath(dir), JSON.stringify({ pending: [rec("new")], tombstones: old }));
    const store = makeStore(dir, async () => {});
    expect(store.suppressed("t0")).toBe(false); // the oldest fell out when "new" was tombstoned (51st)
    expect(store.suppressed("t49")).toBe(true);
    expect(store.suppressed("new")).toBe(true);
  });

  it("a failed pre-ACK persist rolls the stage back and schedules NOTHING (durable-or-nothing)", async () => {
    const dir = freshDir();
    const ran: string[] = [];
    const store = makeStore(dir, async (r) => {
      ran.push(r.id);
    });
    // Construction persisted fine; now make the WAL path unwritable (rename onto a directory fails).
    rmSync(walPath(dir));
    mkdirSync(walPath(dir));
    expect(() => store.accept(rec("1"))).toThrow(); // the throw is the caller's 500 → redelivery
    await new Promise((r) => setTimeout(r, 30));
    expect(ran).toEqual([]); // nothing was scheduled — a redelivery cannot double-run
  });

  it("update(id, patch) merges into the HELD record and persists it (a replay sees it)", async () => {
    const dir = freshDir();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: (number | undefined)[] = [];
    const store = makeStore(dir, async (r) => {
      await gate;
      seen.push(r.previewId); // the runner reads the store's record — the patch is visible
    });
    store.accept(rec("1"));
    store.update("1", { previewId: 42 });
    expect(readWal(dir).pending[0]?.previewId).toBe(42); // durable — a replay after a crash reuses it
    release();
    await until(() => seen.length === 1);
    expect(seen).toEqual([42]);
  });

  it("a runner rejection is logged, never an unhandled rejection — and the chain continues", async () => {
    const dir = freshDir();
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    // Pin the "never unhandled" half of the name literally: collect any unhandled rejection during the
    // test window. (The chain-continues assertions below hold even WITHOUT the store's catch —
    // `prev.then(task, task)` and the `finally` guarantee those — so they must not stand in for it.)
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const done: string[] = [];
      const store = makeStore(dir, async (r) => {
        if (r.id === "1") throw new Error("runner escaped");
        done.push(r.id);
      });
      store.accept(rec("1"));
      store.accept(rec("2")); // same session — must still run after 1's rejection
      await until(() => done.length === 1);
      expect(done).toEqual(["2"]);
      await until(() => readWal(dir).pending.length === 0); // both drained from the WAL
      // The discriminating assertions: the catch EXISTS and is LOUD — a silent `catch {}` regression
      // (exactly the fail-visibly violation this backstop prevents) turns this red.
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toMatch(/turn 1 runner rejected.*runner escaped/);
      await new Promise((r) => setTimeout(r, 20)); // let Node surface any unhandled rejection
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
