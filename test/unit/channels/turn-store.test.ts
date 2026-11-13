import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TurnRecordBase, createTurnStore } from "../../../src/channels/kit/turn-store.ts";

interface Rec extends TurnRecordBase {
  seq: number;
}

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Rec).id === "string" &&
  typeof (v as Rec).conversation === "string" &&
  typeof (v as Rec).attempts === "number" &&
  typeof (v as Rec).seq === "number";

const roots: string[] = [];
function storePath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "fa-turn-store-"));
  roots.push(dir);
  return { dir, path: join(dir, "turns.json") };
}

const openStore = (path: string) =>
  createTurnStore<Rec>(path, {
    label: "[test]",
    isRecord: isRec,
    order: (a, b) => a.seq - b.seq,
  });

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("turn-store: durable turn recovery and poison-turn cap", () => {
  it("recovers turns in arrival order across restart and preserves answered-pending-delivery state", () => {
    const { path } = storePath();
    const first = openStore(path);
    first.add({ id: "t2", conversation: "c1", attempts: 0, seq: 2 });
    first.add({ id: "t1", conversation: "c1", attempts: 0, seq: 1 });
    // Redelivery of an already-persisted turn is idempotent.
    first.add({ id: "t1", conversation: "c1", attempts: 0, seq: 99 });
    expect(first.answered("t1", "reply-1", "s1:e1")).toBe(true);

    const recovered = openStore(path).recover();
    expect(recovered).toEqual([
      { id: "t1", conversation: "c1", attempts: 0, seq: 1, answer: "reply-1", answerKey: "s1:e1" },
      { id: "t2", conversation: "c1", attempts: 0, seq: 2 },
    ]);
  });

  it("drops a poison turn after 3 attempts and removes it from disk", () => {
    const { path } = storePath();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = openStore(path);
    store.add({ id: "poison", conversation: "c1", attempts: 0, seq: 1 });

    expect(store.startAttempt("poison")).toBe("run");
    expect(store.startAttempt("poison")).toBe("run");
    expect(store.startAttempt("poison")).toBe("run");
    expect(store.startAttempt("poison")).toBe("exceeded");
    expect(openStore(path).recover()).toEqual([]);
  });

  it("rolls back memory when pre-ACK add fails, and defers startAttempt if bump cannot persist", () => {
    const { dir, path } = storePath();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = openStore(path);
    store.add({ id: "ok", conversation: "c1", attempts: 0, seq: 1 });

    // Blocking writes via read-only temp file directory (`turns.json.tmp` cannot be created) or directory conflict:
    // put a directory at `turns.json.tmp` so writeFileAtomic fails even as root or non-root.
    mkdirSync(`${path}.tmp`, { recursive: true });
    expect(() => store.add({ id: "fail", conversation: "c1", attempts: 0, seq: 2 })).toThrow(
      /EISDIR|illegal operation on a directory/,
    );
    expect(store.startAttempt("ok")).toBe("defer");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ok: { id: "ok", conversation: "c1", attempts: 0, seq: 1 },
    });

    rmSync(`${path}.tmp`, { recursive: true, force: true });
    expect(store.startAttempt("ok")).toBe("run");
    expect(dir.length).toBeGreaterThan(0);
  });

  it("degrades corrupt JSON or invalid record shapes to empty state without crashing", () => {
    const { path } = storePath();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(path, "{not-valid-json");
    expect(openStore(path).recover()).toEqual([]);

    writeFileSync(path, JSON.stringify({ bad: { id: "x", attempts: "oops" } }));
    expect(openStore(path).recover()).toEqual([]);
  });
});
