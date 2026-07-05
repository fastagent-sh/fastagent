import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type StoredTurn, createTurnStore } from "../src/channels/telegram/turn-store.ts";

const dirs: string[] = [];
const freshPath = (): string => {
  const d = mkdtempSync(join(tmpdir(), "turn-store-"));
  dirs.push(d);
  return join(d, "turns.json");
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const turn = (id: string, extra: Partial<StoredTurn> = {}): StoredTurn => ({
  id,
  session: "s1",
  placeKey: "p1",
  baseText: "hi",
  chatId: 42,
  imageFileIds: [],
  fileIds: [],
  attempts: 0,
  ...extra,
});

describe("turn-store", () => {
  it("persists an accepted turn and recovers it across a restart, WITHOUT bumping (read-only)", () => {
    const path = freshPath();
    createTurnStore(path).add(turn("t1"));
    const recovered = createTurnStore(path).recover();
    expect(recovered).toMatchObject([{ id: "t1", attempts: 0 }]); // recover does not touch the count
  });

  it("re-add of an existing id is idempotent — a redelivery does not reset the execution count", () => {
    const path = freshPath();
    const store = createTurnStore(path);
    store.add(turn("t1"));
    store.startAttempt("t1", 3); // attempts -> 1
    store.add(turn("t1")); // redelivery re-submits the same update_id (a fresh record with attempts:0)
    expect(createTurnStore(path).recover()).toMatchObject([{ id: "t1", attempts: 1 }]); // preserved, not reset
  });

  it("recovers in ARRIVAL (numeric update_id) order regardless of on-disk key order", () => {
    const path = freshPath();
    // Persist out of order: higher update_id written first. Recovery must still hand them back ascending
    // (= arrival), so the queue rebuilds each session's FIFO chain correctly.
    writeFileSync(
      path,
      JSON.stringify({
        "30": turn("30"),
        "9": turn("9"),
        "100": turn("100"),
      }),
    );
    expect(
      createTurnStore(path)
        .recover()
        .map((t) => t.id),
    ).toEqual(["9", "30", "100"]);
  });

  it("a removed turn is not recovered (turn ended — only a crash leaves it)", () => {
    const path = freshPath();
    const store = createTurnStore(path);
    store.add(turn("t1"));
    store.remove("t1");
    expect(createTurnStore(path).recover()).toHaveLength(0);
  });

  it("startAttempt bumps the execution count and persists it", () => {
    const path = freshPath();
    createTurnStore(path).add(turn("t1"));
    expect(createTurnStore(path).startAttempt("t1", 3)).toBe("run");
    expect(createTurnStore(path).recover()).toMatchObject([{ id: "t1", attempts: 1 }]); // durable bump
  });

  it("keeps a turn that lands exactly ON maxAttempts (the > vs >= boundary)", () => {
    const path = freshPath();
    createTurnStore(path).add(turn("edge", { attempts: 2 }));
    expect(createTurnStore(path).startAttempt("edge", 3)).toBe("run"); // 2 -> 3, still <= 3, not dropped
    expect(createTurnStore(path).recover()).toMatchObject([{ id: "edge", attempts: 3 }]);
  });

  it("an unknown id runs untracked (a redelivery double-run whose first run already removed the record)", () => {
    expect(createTurnStore(freshPath()).startAttempt("gone", 3)).toBe("run");
  });

  it("drops a turn on its N+1th start (over maxAttempts) and persists the drop", () => {
    const path = freshPath();
    const store = createTurnStore(path);
    store.add(turn("poison", { attempts: 3 }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(store.startAttempt("poison", 3)).toBe("exceeded"); // 3 -> 4 > 3, dropped
    expect(err).toHaveBeenCalledWith(expect.stringContaining("dropping turn poison"));
    expect(createTurnStore(path).recover()).toHaveLength(0); // the drop is persisted
  });

  it("the ceiling converges across restarts: counts climb 1→2→3 then the 4th start is dropped", () => {
    // Each "restart" is a fresh store over the same file — exercises the real bump→persist→reload cycle
    // end to end (the seeded-count tests above each cover only one link).
    const path = freshPath();
    createTurnStore(path).add(turn("t1")); // accepted, attempts 0
    expect(createTurnStore(path).startAttempt("t1", 3)).toBe("run"); // → 1
    expect(createTurnStore(path).startAttempt("t1", 3)).toBe("run"); // → 2
    expect(createTurnStore(path).startAttempt("t1", 3)).toBe("run"); // → 3
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(createTurnStore(path).startAttempt("t1", 3)).toBe("exceeded"); // 4th start > 3 → dropped
    expect(createTurnStore(path).recover()).toHaveLength(0);
  });

  it("a poison head does NOT penalize its never-run siblings (the ceiling is per turn)", () => {
    // A (poison) sits ahead of B in the same session; across restarts only A ever runs (it crashes the
    // process before B is dequeued). B's count must stay 0 so it gets its full budget once A is gone.
    const path = freshPath();
    const store = createTurnStore(path);
    store.add(turn("A", { session: "s", attempts: 3 }));
    store.add(turn("B", { session: "s", attempts: 0 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    // recover re-enqueues both, untouched; A is dropped when IT runs, B is not.
    expect(
      createTurnStore(path)
        .recover()
        .map((t) => `${t.id}:${t.attempts}`),
    ).toEqual(["A:3", "B:0"]);
    expect(store.startAttempt("A", 3)).toBe("exceeded");
    expect(store.startAttempt("B", 3)).toBe("run"); // B was never charged for A's crashes
    expect(createTurnStore(path).recover()).toMatchObject([{ id: "B", attempts: 1 }]); // only B survives, at 1
  });

  it("add() throws AND rolls back when the pre-ACK write fails (→ webhook 500 → Telegram redelivers)", () => {
    const d = mkdtempSync(join(tmpdir(), "turn-store-"));
    dirs.push(d);
    const sub = join(d, "sub");
    mkdirSync(sub);
    const store = createTurnStore(join(sub, "turns.json")); // constructs on an empty (ENOENT) file
    rmSync(sub, { recursive: true });
    writeFileSync(sub, "x"); // the parent is now a FILE — saveStateFile's mkdir/write fails
    expect(() => store.add(turn("t1"))).toThrow(); // the pre-ACK contract: surface the write failure
    // Rolled back: the id is NOT left in memory, so a redelivery re-attempts the write (throws again)
    // rather than short-circuiting on turns.has and running the turn with its intent never persisted.
    expect(() => store.add(turn("t1"))).toThrow();
  });

  it("remove() swallows a post-ACK write failure (must not abort delivery)", () => {
    const d = mkdtempSync(join(tmpdir(), "turn-store-"));
    dirs.push(d);
    const sub = join(d, "sub");
    mkdirSync(sub);
    const path = join(sub, "turns.json");
    const store = createTurnStore(path);
    store.add(turn("t1")); // persisted OK while `sub` is a dir
    rmSync(sub, { recursive: true });
    writeFileSync(sub, "x"); // now the parent is a FILE — the next write fails
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => store.remove("t1")).not.toThrow(); // post-ACK: logged, never thrown
    expect(err).toHaveBeenCalledWith(expect.stringContaining("post-ACK"));
  });

  it("startAttempt DEFERS when the bump can't persist — skip now, replay next start (not a drop)", () => {
    const d = mkdtempSync(join(tmpdir(), "turn-store-"));
    dirs.push(d);
    const sub = join(d, "sub");
    mkdirSync(sub);
    const path = join(sub, "turns.json");
    const store = createTurnStore(path);
    store.add(turn("t1", { attempts: 1 })); // persisted OK while `sub` is a dir
    rmSync(sub, { recursive: true });
    writeFileSync(sub, "x"); // now the parent is a FILE — the bump write fails
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(store.startAttempt("t1", 3)).toBe("defer"); // an unpersistable bump must not run the turn
    expect(err).toHaveBeenCalledWith(expect.stringContaining("deferring"));
  });

  it("degrades a wrong-shape state file to empty (IO boundary), with a warning", () => {
    const path = freshPath();
    writeFileSync(path, JSON.stringify({ t1: { id: "t1", session: 5 } })); // attempts/strings missing
    const err = vi.spyOn(console, "error").mockImplementation(() => {}); // log.warn/error both → console.error
    expect(createTurnStore(path).recover()).toHaveLength(0);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("unexpected shape"));
  });
});
