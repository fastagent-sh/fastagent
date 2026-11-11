import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaceHistory } from "../src/channels/kit/place-history.ts";
import { log } from "../src/log.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A place history over a platform with nothing to say: what each read is handed shows what the place remembers. */
function setup(path?: string) {
  const root = mkdtempSync(join(tmpdir(), "place-history-"));
  roots.push(root);
  const read = vi.fn(async (_key: string, _from: { after?: number; drop(id: string): boolean }, _until?: number) => ({
    messages: [],
    earlier: false,
  }));
  const open = (file = path ?? join(root, "history.json")) =>
    createPlaceHistory<number>({ label: "[test]", path: file, read });
  const history = open();
  /** Whether a read of `key` would leave `id` out: a recorded output the place still holds. */
  const drops = async (key: string, id: string, reader = history, conversation = "c"): Promise<boolean> => {
    await reader.fold({ key, conversation, until: Number.MAX_SAFE_INTEGER });
    return read.mock.lastCall?.[1].drop(id) ?? false;
  };
  return { history, read, drops, open, root };
}

describe("place history", () => {
  it("hands a read the range it was asked for, and records nothing of it", async () => {
    const { history, read } = setup();
    await history.fold({ key: "p", conversation: "c", after: 5, until: 9 });
    expect(read.mock.lastCall?.[0]).toBe("p");
    expect(read.mock.lastCall?.[1].after).toBe(5);
    expect(read.mock.lastCall?.[2]).toBe(9);
    await history.fold({ key: "p", conversation: "c", until: 12 });
    expect(read.mock.lastCall?.[1].after).toBeUndefined(); // the place keeps no cursor: a read starts where it is told to
  });

  it("leaves out what a turn posted into the place, until the place is forgotten", async () => {
    const { history, drops } = setup();
    history.recordOutput("p", "c", "answer-1");
    expect(await drops("p", "answer-1")).toBe(true);
    expect(await drops("p", "someone-else")).toBe(false);
    expect(await drops("other", "answer-1")).toBe(false); // an output belongs to its place
  });

  it("leaves an output out of its own conversation's read only: another conversation was told it", async () => {
    const { history, drops } = setup();
    history.recordOutput("p", "alice", "answer-to-alice");
    expect(await drops("p", "answer-to-alice", history, "alice")).toBe(true); // alice's session holds it
    expect(await drops("p", "answer-to-alice", history, "bob")).toBe(false); // bob's session was never told
  });

  it("keeps outputs across a restart", async () => {
    const { history, drops, open } = setup();
    history.recordOutput("p", "c", "answer-1");
    expect(await drops("p", "answer-1", open())).toBe(true);
  });

  it("keeps a place's newest outputs only", async () => {
    const { history, drops } = setup();
    for (let i = 0; i < 250; i++) history.recordOutput("p", "c", `answer-${i}`);
    expect(await drops("p", "answer-249")).toBe(true);
    expect(await drops("p", "answer-50")).toBe(true);
    expect(await drops("p", "answer-49")).toBe(false);
  });

  it("forgets the least recently used place when there are too many, but not the one just recorded", async () => {
    const { history, drops } = setup();
    for (let i = 0; i < 2000; i++) history.recordOutput(`place-${i}`, "c", `answer-${i}`);
    history.recordOutput("busy", "c", "answer-busy");
    expect(await drops("busy", "answer-busy")).toBe(true);
    expect(await drops("place-0", "answer-0")).toBe(false); // the oldest paid for it
    expect(await drops("place-1", "answer-1")).toBe(true);
  });

  it("says an unreadable place in the turn's text and lets the turn go on", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const { history, read } = setup();
    read.mockRejectedValueOnce(new Error("platform down"));
    const folded = await history.fold({ key: "p", conversation: "c", until: 1 });
    expect(folded.text).toContain("could not read the recent discussion here: Error: platform down");
    expect(folded.folded).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).toContain("platform down");
  });
});
