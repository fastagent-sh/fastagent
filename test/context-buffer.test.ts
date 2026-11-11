import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import { type BufferEntry, collectAttachments, createContextBuffer } from "../src/channels/telegram/context-buffer.ts";

const dirs: string[] = [];
const freshPath = (): string => {
  const d = mkdtempSync(join(tmpdir(), "ctx-buffer-"));
  dirs.push(d);
  return join(d, "buffers.json");
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (sender: string, body: string, messageId: number, extra: Partial<BufferEntry> = {}): BufferEntry => ({
  sender,
  body,
  messageId,
  ...extra,
});

/** What a turn asked at message `until` folds, after the ask its session was last sent. */
const fold = (buf: ReturnType<typeof createContextBuffer>, range: { after?: number; until: number } = { until: 1e9 }) =>
  buf.fold("place", range);

describe("context-buffer", () => {
  it("renders the fold with msg and reply annotations", () => {
    const buf = createContextBuffer(freshPath());
    buf.push("place", entry("@alice", "plain line", 2));
    buf.push("place", entry("@bob", "a reply", 3, { replyTo: 1 }));
    expect(fold(buf).text).toBe("@alice (msg 2): plain line\n@bob (msg 3, reply to msg 1): a reply");
  });

  it("folds what came after the ask its session was last sent, up to the turn's own ask — and consumes nothing", () => {
    const buf = createContextBuffer(freshPath());
    for (const id of [1, 2, 3, 4, 5]) buf.push("place", entry("@u", `line ${id}`, id));
    // The session's last ask was message 2; this turn's ask is message 4: it reads 3 and 4, not 5 (a later turn's).
    expect(fold(buf, { after: 2, until: 4 }).folded.map((e) => e.messageId)).toEqual([3, 4]);
    // Reading changes nothing: the same range reads the same again, and another reader's range is its own.
    expect(fold(buf, { after: 2, until: 4 }).folded.map((e) => e.messageId)).toEqual([3, 4]);
    expect(fold(buf, { until: 3 }).folded.map((e) => e.messageId)).toEqual([1, 2, 3]);
    expect(fold(buf, { after: 5, until: 9 }).text).toBe("");
  });

  it("an entry that stands at a reader's own last ask counts as after it only when it came later", () => {
    const buf = createContextBuffer(freshPath());
    buf.push("place", entry("@alice", "the ask itself", 5));
    buf.push("place", { ...entry("you (sent by the agent)", "an answer done after it", 3), at: 5 });
    // The reader's last ask was message 5. The ask is not read again; the answer standing at the same place is.
    expect(fold(buf, { after: 5, until: 9 }).folded.map((e) => e.body)).toEqual(["an answer done after it"]);
    // Read from before it, both are in order, and the answer's own message id is what the model sees.
    expect(fold(buf, { until: 9 }).text).toBe(
      "@alice (msg 5): the ask itself\nyou (sent by the agent) (msg 3): an answer done after it",
    );
  });

  it("evicts the OLDEST entries when the rendered fold exceeds the budget", () => {
    const buf = createContextBuffer(freshPath());
    for (let i = 0; i < 20; i++) buf.push("place", entry(`@u${i}`, "x".repeat(300), i + 1)); // ~6000 rendered chars
    const { text } = fold(buf);
    expect(text.length).toBeLessThanOrEqual(4000 + 330); // budget + at most one entry of slack
    expect(text).not.toContain("@u0 "); // the oldest fell out
    expect(text).toContain("@u19 "); // the newest survives
  });

  it("persists across a restart (a new instance over the same file sees the entries)", () => {
    const path = freshPath();
    createContextBuffer(path).push("place", entry("@alice", "durable line", 7));
    expect(fold(createContextBuffer(path)).text).toBe("@alice (msg 7): durable line");
  });

  it("an entry of an older shape costs its own place's buffer, not every place's", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const path = freshPath();
    writeFileSync(
      path,
      JSON.stringify({
        "-100": [{ sender: "@a", body: "kept", messageId: 5 }],
        "-200": [{ sender: "you (sent by the agent)", body: "no id" }], // an older shape: no messageId
      }),
    );
    const buf = createContextBuffer(path);
    expect(buf.fold("-100", { until: 1e9 }).text).toBe("@a (msg 5): kept");
    expect(buf.fold("-200", { until: 1e9 }).text).toBe("");
    expect(warn.mock.calls.flat().join(" ")).toContain("1 place(s)");
  });

  it("starts empty, and says so, from a file that is not a map of places", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const path = freshPath();
    writeFileSync(path, JSON.stringify(["not", "a map"]));
    expect(fold(createContextBuffer(path)).text).toBe("");
    expect(warn.mock.calls.flat().join(" ")).toContain("unexpected shape");
  });

  it("a failed pre-ACK persist rolls the push back — memory matches disk, a redelivery re-pushes once", () => {
    const path = freshPath();
    const buf = createContextBuffer(path);
    buf.push("place", entry("@alice", "kept", 1));
    rmSync(path);
    mkdirSync(path); // make the file unwritable (rename onto a directory fails)
    expect(() => buf.push("place", entry("@bob", "rolled back", 2))).toThrow();
    expect(fold(buf).text).toBe("@alice (msg 1): kept"); // the failed entry is NOT in memory either
  });

  it("collectAttachments: primary-filtered, deduped, capped, and the skipped count is honest", () => {
    const folded: BufferEntry[] = [
      entry("@a", "one", 1, { fileIds: ["f1"] }),
      entry("@b", "two", 2, { fileIds: ["f2", "f2"] }), // duplicate id within the window
      entry("@c", "three", 3, { fileIds: ["f3"], imageIds: ["p1"] }),
      entry("@d", "four", 4, { fileIds: ["f4"] }),
      entry("@e", "five", 5, { fileIds: ["primary"] }), // also on the summoning message
    ];
    const got = collectAttachments(folded, { files: new Set(["primary"]), images: new Set() });
    // 4 unique non-primary files → cap 3 keeps the most recent, 1 skipped (counted, not silent)
    expect(got.files.map((f) => f.id)).toEqual(["f2", "f3", "f4"]);
    expect(got.files[1]).toMatchObject({ id: "f3", from: "@c", msg: 3 }); // attribution rides along
    expect(got.images.map((i) => i.id)).toEqual(["p1"]);
    expect(got.skipped).toBe(1);
  });
});
