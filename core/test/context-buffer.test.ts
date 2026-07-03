import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BufferEntry, collectAttachments, createContextBuffer } from "../src/channels/telegram/context-buffer.ts";

const dirs: string[] = [];
const freshPath = (): string => {
  const d = mkdtempSync(join(tmpdir(), "ctx-buffer-"));
  dirs.push(d);
  return join(d, "buffers.json");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (sender: string, body: string, extra: Partial<BufferEntry> = {}): BufferEntry => ({
  sender,
  body,
  ...extra,
});

describe("context-buffer", () => {
  it("renders the fold with msg/reply annotations, only when known", () => {
    const buf = createContextBuffer(freshPath());
    buf.push("place", entry("@alice", "plain line"));
    buf.push("place", entry("@bob", "a reply", { messageId: 3, replyTo: 1 }));
    const { text } = buf.peek("place");
    expect(text).toBe("@alice: plain line\n@bob (msg 3, reply to msg 1): a reply");
  });

  it("commit removes ONLY the consumed snapshot (identity) — an entry pushed mid-turn survives", () => {
    const buf = createContextBuffer(freshPath());
    buf.push("place", entry("@alice", "before the turn"));
    const { consumed } = buf.peek("place"); // the turn folds this snapshot
    buf.push("place", entry("@bob", "arrived while the turn ran"));
    buf.commit("place", consumed); // turn completed — clear exactly what was folded
    expect(buf.peek("place").text).toBe("@bob: arrived while the turn ran");
  });

  it("evicts the OLDEST entries when the rendered fold exceeds the budget", () => {
    const buf = createContextBuffer(freshPath());
    for (let i = 0; i < 20; i++) buf.push("place", entry(`@u${i}`, "x".repeat(300))); // ~6000 rendered chars
    const { text } = buf.peek("place");
    expect(text.length).toBeLessThanOrEqual(4000 + 320); // budget + at most one entry of slack
    expect(text).not.toContain("@u0:"); // the oldest fell out
    expect(text).toContain("@u19:"); // the newest survives
  });

  it("persists across a restart (a new instance over the same file sees the entries)", () => {
    const path = freshPath();
    createContextBuffer(path).push("place", entry("@alice", "durable line"));
    expect(createContextBuffer(path).peek("place").text).toBe("@alice: durable line");
  });

  it("a failed pre-ACK persist rolls the push back — memory matches disk, a redelivery re-pushes once", () => {
    const path = freshPath();
    const buf = createContextBuffer(path);
    buf.push("place", entry("@alice", "kept"));
    rmSync(path);
    mkdirSync(path); // make the file unwritable (rename onto a directory fails)
    expect(() => buf.push("place", entry("@bob", "rolled back"))).toThrow();
    expect(buf.peek("place").text).toBe("@alice: kept"); // the failed entry is NOT in memory either
  });

  it("collectAttachments: primary-filtered, deduped, capped, and the skipped count is honest", () => {
    const consumed: BufferEntry[] = [
      entry("@a", "one", { messageId: 1, fileIds: ["f1"] }),
      entry("@b", "two", { messageId: 2, fileIds: ["f2", "f2"] }), // duplicate id within the window
      entry("@c", "three", { messageId: 3, fileIds: ["f3"], imageIds: ["p1"] }),
      entry("@d", "four", { messageId: 4, fileIds: ["f4"] }),
      entry("@e", "five", { messageId: 5, fileIds: ["primary"] }), // also on the summoning message
    ];
    const got = collectAttachments(consumed, { files: new Set(["primary"]), images: new Set() });
    // 4 unique non-primary files → cap 3 keeps the most recent, 1 skipped (counted, not silent)
    expect(got.files.map((f) => f.id)).toEqual(["f2", "f3", "f4"]);
    expect(got.files[1]).toMatchObject({ id: "f3", from: "@c", msg: 3 }); // attribution rides along
    expect(got.images.map((i) => i.id)).toEqual(["p1"]);
    expect(got.skipped).toBe(1);
  });
});
