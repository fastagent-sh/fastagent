import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaceHistory } from "../src/channels/kit/place-history.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A place history over a platform with nothing to say: what each read is handed shows what the place remembers. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "place-history-"));
  roots.push(root);
  const read = vi.fn(async (_key: string, _from: { cursor?: number }) => ({
    covered: [],
    messages: [],
    earlier: false,
  }));
  const history = createPlaceHistory<number>({
    label: "[test]",
    path: join(root, "history.json"),
    isCursor: (value): value is number => typeof value === "number",
    compare: (a, b) => a - b,
    isTurnInput: () => false,
    read,
  });
  const answered = async (key: string, until: number) => {
    const peeked = await history.peek({ key, until });
    history.commit({ key, until }, peeked.consumed);
  };
  const cursorOf = async (key: string): Promise<number | undefined> => {
    await history.peek({ key, until: Number.MAX_SAFE_INTEGER });
    return read.mock.lastCall?.[1].cursor;
  };
  return { history, answered, cursorOf };
}

describe("place history state", () => {
  it("places no read has reached are dropped before a quiet place's cursor", async () => {
    const { history, answered, cursorOf } = setup();
    await answered("quiet", 7);
    // A busy deployment's answers, each in a thread nobody asks in again (2,000 is the bound).
    for (let i = 0; i < 2000; i++) history.recordOutput(`thread-${i}`, `answer-${i}`);
    expect(await cursorOf("quiet")).toBe(7);
  });

  it("when every place has a cursor, the least recently used goes, never the one just written", async () => {
    const { history, answered, cursorOf } = setup();
    for (let i = 0; i < 2000; i++) await answered(`place-${i}`, i + 1);
    history.recordOutput("new-thread", "answer");
    expect(await cursorOf("place-0")).toBeUndefined();
    expect(await cursorOf("place-1")).toBe(2);
  });
});
