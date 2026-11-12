import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import { type BufferEntry, collectAttachments, createContextBuffer } from "../src/channels/telegram/context-buffer.ts";

const dirs: string[] = [];
const freshPath = (): string => {
  const d = mkdtempSync(join(tmpdir(), "ctx-buffer-"));
  dirs.push(d);
  return join(d, "buffers");
};
/** The file a place is kept in, as the buffer names it. */
const fileOf = (dir: string, place: string): string => join(dir, `${encodeURIComponent(place)}.json`);
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A day, and a clock the tests move: an entry is said "now" unless it is given its own time. */
const DAY = 24 * 60 * 60 * 1000;
let clock = Date.UTC(2026, 10, 1);
const now = () => clock;
const entry = (sender: string, body: string, messageId: number, extra: Partial<BufferEntry> = {}): BufferEntry => ({
  sender,
  body,
  messageId,
  date: clock,
  ...extra,
});
const open = (path: string) => createContextBuffer(path, { now });

/** What a turn asked at message `until` folds, after the ask its session was last sent, with room to hold it all. */
const fold = (
  buf: ReturnType<typeof createContextBuffer>,
  range: { after?: number; until?: number; budget?: number } = {},
) => buf.fold("place", { until: 1e9, budget: 1e9, ...range });

describe("context-buffer", () => {
  it("renders the fold with msg and reply annotations", () => {
    const buf = open(freshPath());
    buf.push("place", entry("@alice", "plain line", 2));
    buf.push("place", entry("@bob", "a reply", 3, { replyTo: 1 }));
    expect(fold(buf).text).toBe("@alice (msg 2): plain line\n@bob (msg 3, reply to msg 1): a reply");
  });

  it("folds what came after the ask its session was last sent, up to the turn's own ask — and consumes nothing", () => {
    const buf = open(freshPath());
    for (const id of [1, 2, 3, 4, 5]) buf.push("place", entry("@u", `line ${id}`, id));
    // The session's last ask was message 2; this turn's ask is message 4: it reads 3 and 4, not 5 (a later turn's).
    expect(fold(buf, { after: 2, until: 4 }).folded.map((e) => e.messageId)).toEqual([3, 4]);
    // Reading changes nothing: the same range reads the same again, and another reader's range is its own.
    expect(fold(buf, { after: 2, until: 4 }).folded.map((e) => e.messageId)).toEqual([3, 4]);
    expect(fold(buf, { until: 3 }).folded.map((e) => e.messageId)).toEqual([1, 2, 3]);
    expect(fold(buf, { after: 5, until: 9 }).text).toBe("");
  });

  it("an entry that stands at a reader's own last ask counts as after it only when it came later", () => {
    const buf = open(freshPath());
    buf.push("place", entry("@alice", "the ask itself", 5));
    buf.push("place", { ...entry("you (sent by the agent)", "an answer done after it", 3), at: 5 });
    // The reader's last ask was message 5. The ask is not read again; the answer standing at the same place is.
    expect(fold(buf, { after: 5, until: 9 }).folded.map((e) => e.body)).toEqual(["an answer done after it"]);
    // Read from before it, both are in order, and the answer's own message id is what the model sees.
    expect(fold(buf, { until: 9 }).text).toBe(
      "@alice (msg 5): the ask itself\nyou (sent by the agent) (msg 3): an answer done after it",
    );
  });

  it("folds newest-first into the budget it is given, and says what it left out", () => {
    const buf = open(freshPath());
    for (let i = 0; i < 20; i++) buf.push("place", entry(`@u${i}`, "x".repeat(300), i + 1)); // ~6000 rendered chars
    const { text } = fold(buf, { budget: 1000 });
    expect(text).toMatch(/^\(\d+ earlier messages here not shown\)\n/);
    expect(text).not.toContain("@u0 "); // the oldest fell out
    expect(text).toContain("@u19 "); // the newest survives
    expect(text.length).toBeLessThanOrEqual(1000 + 60); // the budget, and the notice
  });

  it("holds everything a place said inside the retention, whatever its size: only time bounds it", () => {
    const buf = open(freshPath());
    for (let i = 0; i < 200; i++) buf.push("place", entry("@u", "x".repeat(300), i + 1)); // ~62,000 characters
    expect(fold(buf).folded).toHaveLength(200);
    expect(fold(buf).text).not.toContain("not shown");
  });

  describe("retention", () => {
    it("drops what is older than the retention, on the next push, and a restart", () => {
      const path = freshPath();
      const buf = open(path);
      buf.push("place", entry("@old", "said long ago", 1));
      clock += 13 * DAY;
      buf.push("place", entry("@mid", "said 13 days later", 2));
      expect(fold(buf).folded.map((e) => e.messageId)).toEqual([1, 2]); // 13 days: still kept
      clock += 2 * DAY; // the first is now 15 days old, the second 2
      buf.push("place", entry("@new", "said now", 3));
      expect(fold(buf).folded.map((e) => e.messageId)).toEqual([2, 3]);
      expect(fold(open(path)).folded.map((e) => e.messageId)).toEqual([2, 3]); // gone from the file too
    });

    it("does not fold what has expired though nothing has pushed since: a quiet place is still bounded", () => {
      const buf = open(freshPath());
      buf.push("place", entry("@old", "said long ago", 1));
      clock += 15 * DAY;
      expect(fold(buf).folded).toEqual([]);
    });

    it("says that older messages are no longer kept to a reader who has not read past them, once and no more", () => {
      const buf = open(freshPath());
      buf.push("place", entry("@old", "said long ago", 1));
      buf.push("place", entry("@old", "also long ago", 2));
      clock += 15 * DAY;
      buf.push("place", entry("@new", "said now", 10));
      // Never read here, or last read before what was dropped: it is told, ahead of what remains.
      expect(fold(buf).text).toBe("(messages here older than 14 days are no longer kept)\n@new (msg 10): said now");
      expect(fold(buf, { after: 1 }).text).toContain("no longer kept");
      // Read past it (its last ask was message 5 or later): nothing it needs is missing, so nothing is said.
      expect(fold(buf, { after: 5 }).text).toBe("@new (msg 10): said now");
    });

    it("says it too when nothing is left, so an empty fold is not taken for a quiet place", () => {
      const buf = open(freshPath());
      buf.push("place", entry("@old", "said long ago", 1));
      clock += 15 * DAY;
      buf.push("other", entry("@elsewhere", "another place pushes", 1));
      expect(fold(buf).text).toBe("(messages here older than 14 days are no longer kept)");
    });

    it("tidies a quiet place's file too, within the hour after its entries expire, and not before", () => {
      const dir = freshPath();
      const buf = open(dir);
      buf.push("quiet", entry("@old", "said long ago", 1));
      clock += 15 * DAY;
      buf.push("busy", entry("@new", "first push after", 1)); // the sweep is due: the quiet place's file is rewritten
      expect(readFileSync(fileOf(dir, "quiet"), "utf8")).not.toContain("said long ago");
      expect(JSON.parse(readFileSync(fileOf(dir, "quiet"), "utf8")).expiredThrough).toBe(1);
    });

    it("sweeps at most once an hour: a push in between leaves a quiet place's file alone", () => {
      const dir = freshPath();
      const buf = open(dir);
      const minute = 60 * 1000;
      buf.push("quiet", entry("@q", "said at the start", 1));
      clock += 14 * DAY - 10 * minute;
      buf.push("busy", entry("@a", "a sweep is due, and nothing has expired", 1));
      clock += 20 * minute; // "quiet"'s entry is now 14 days and 10 minutes old, and the sweep was 20 minutes ago
      buf.push("busy", entry("@a", "inside the hour", 2));
      expect(readFileSync(fileOf(dir, "quiet"), "utf8")).toContain("said at the start"); // not rewritten yet
      clock += 50 * minute; // an hour since the sweep
      buf.push("busy", entry("@a", "the next sweep", 3));
      expect(JSON.parse(readFileSync(fileOf(dir, "quiet"), "utf8")).entries).toEqual([]);
    });

    it("says a sweep that could not rewrite a quiet place, and still never folds what has expired", () => {
      const dir = freshPath();
      const buf = open(dir);
      buf.push("quiet", entry("@old", "said long ago", 1));
      clock += 15 * DAY;
      rmSync(fileOf(dir, "quiet"));
      mkdirSync(fileOf(dir, "quiet")); // the sweep's rewrite of this place fails
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      expect(() => buf.push("busy", entry("@new", "now", 1))).not.toThrow(); // another chat's push is not failed by it
      expect(warn.mock.calls.flat().join(" ")).toContain("could not tidy place quiet of what has expired");
      expect(buf.fold("quiet", { until: 1e9, budget: 1e9 }).folded).toEqual([]);
    });

    it("tries a failed sweep again at the next one, and the file loses what expired once it can", () => {
      const dir = freshPath();
      const buf = open(dir);
      buf.push("quiet", entry("@old", "SECRET said long ago", 1));
      clock += 15 * DAY;
      mkdirSync(`${fileOf(dir, "quiet")}.tmp`); // the atomic rewrite of this file fails; the file itself stays
      vi.spyOn(log, "warn").mockImplementation(() => {});
      buf.push("busy", entry("@a", "first sweep, fails", 1));
      expect(readFileSync(fileOf(dir, "quiet"), "utf8")).toContain("SECRET");
      rmSync(`${fileOf(dir, "quiet")}.tmp`, { recursive: true }); // the obstacle goes
      clock += 2 * 60 * 60 * 1000;
      buf.push("busy", entry("@a", "next sweep", 2));
      expect(readFileSync(fileOf(dir, "quiet"), "utf8")).not.toContain("SECRET");
    });
  });

  describe("a place with nothing left", () => {
    const HOUR = 60 * 60 * 1000;
    it("keeps its note of what it lost for one more retention, then its file and record go", () => {
      const dir = freshPath();
      const buf = open(dir);
      buf.push("quiet", entry("@old", "said long ago", 1));
      clock += 15 * DAY;
      buf.push("busy", entry("@a", "sweeps: quiet loses its entry", 1));
      expect(JSON.parse(readFileSync(fileOf(dir, "quiet"), "utf8"))).toMatchObject({ entries: [], expiredThrough: 1 });
      clock += 13 * DAY; // 13 days after the drop: the note is still kept
      buf.push("busy", entry("@a", "a", 2));
      expect(existsSync(fileOf(dir, "quiet"))).toBe(true);
      expect(buf.fold("quiet", { until: 1e9, budget: 1e9 }).text).toContain("no longer kept");
      clock += 2 * DAY + HOUR; // past it
      buf.push("busy", entry("@a", "b", 3));
      expect(existsSync(fileOf(dir, "quiet"))).toBe(false);
      expect(buf.fold("quiet", { until: 1e9, budget: 1e9 })).toEqual({ text: "", folded: [] });
      expect(open(dir).fold("quiet", { until: 1e9, budget: 1e9 }).text).toBe(""); // and a restart does not bring it back
    });

    it("is forgotten at start too, and a place that still holds entries never is, however old its note", () => {
      const dir = freshPath();
      const buf = open(dir);
      buf.push("gone", entry("@old", "said long ago", 1));
      buf.push("kept", entry("@old", "said long ago too", 1));
      clock += 15 * DAY;
      buf.push("kept", entry("@a", "x: drops the old one, and notes it", 2)); // both places' old entries drop here
      clock += 12 * DAY;
      buf.push("kept", entry("@a", "y: said 12 days later", 3));
      clock += 2 * DAY + HOUR; // the note is now a retention old; "x" has expired, "y" is 2 days old
      buf.push("busy", entry("@b", "a sweep is due", 1));
      expect(existsSync(fileOf(dir, "gone"))).toBe(false); // nothing left, and its note a retention old
      const kept = JSON.parse(readFileSync(fileOf(dir, "kept"), "utf8"));
      expect(kept.entries.map((e: BufferEntry) => e.body)).toEqual(["y: said 12 days later"]); // never forgotten
      expect(existsSync(fileOf(dir, "kept"))).toBe(true);
    });

    it("forgets it at a start as well", () => {
      const dir = freshPath();
      const buf = open(dir);
      buf.push("gone", entry("@old", "said long ago", 1));
      clock += 15 * DAY;
      buf.push("busy", entry("@a", "a sweep: gone loses its entry", 1));
      clock += 15 * DAY;
      expect(existsSync(fileOf(dir, "gone"))).toBe(true);
      open(dir);
      expect(existsSync(fileOf(dir, "gone"))).toBe(false);
    });

    it("says a file it could not remove, keeps its record, and removes it at the next sweep once it can", () => {
      const dir = freshPath();
      const buf = open(dir);
      buf.push("quiet", entry("@old", "said long ago", 1));
      clock += 15 * DAY;
      buf.push("busy", entry("@a", "a", 1));
      clock += 15 * DAY;
      const file = fileOf(dir, "quiet");
      rmSync(file);
      mkdirSync(file);
      writeFileSync(join(file, "blocker"), "a directory with a file in it cannot be removed as a file");
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      expect(() => buf.push("busy", entry("@a", "b", 2))).not.toThrow();
      expect(warn.mock.calls.flat().join(" ")).toContain("could not tidy place quiet");
      // The obstacle goes and an ordinary file is where it was: only a record kept in memory finds it to remove.
      rmSync(file, { recursive: true });
      writeFileSync(file, JSON.stringify({ entries: [] }));
      clock += 2 * HOUR;
      buf.push("busy", entry("@a", "c", 3));
      expect(existsSync(file)).toBe(false);
    });
  });

  it("persists across a restart (a new instance over the same file sees the entries)", () => {
    const path = freshPath();
    open(path).push("place", entry("@alice", "durable line", 7));
    expect(fold(open(path)).text).toBe("@alice (msg 7): durable line");
  });

  it("a file of an older shape costs its own place's buffer, not every place's", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const dir = freshPath();
    mkdirSync(dir);
    const place = (entries: unknown) => JSON.stringify({ entries });
    writeFileSync(fileOf(dir, "-100"), place([{ sender: "@a", body: "kept", messageId: 5, date: clock }]));
    writeFileSync(fileOf(dir, "-200"), place([{ sender: "you", body: "no date", messageId: 6 }])); // an older shape
    writeFileSync(
      fileOf(dir, "-300"),
      JSON.stringify([{ sender: "@a", body: "was a list", messageId: 7, date: clock }]),
    );
    writeFileSync(fileOf(dir, "-400"), "{ not json");
    const buf = open(dir);
    const read = (key: string) => buf.fold(key, { until: 1e9, budget: 1e9 }).text;
    expect(read("-100")).toBe("@a (msg 5): kept");
    expect(read("-200")).toBe("");
    expect(read("-300")).toBe("");
    expect(read("-400")).toBe("");
    const said = warn.mock.calls.flat().join(" ");
    expect(said).toContain("3 place(s)"); // the three that cannot be read as a place start empty…
    expect(said).toContain("corrupt state file"); // …and the corrupt file is said as one, on its own
  });

  it("a chat id with separators is a file of its own, and comes back as the same chat", () => {
    const dir = freshPath();
    const buf = open(dir);
    buf.push("-100:3/odd", entry("@a", "in a topic", 1));
    expect(readdirSync(dir)).toEqual([`${encodeURIComponent("-100:3/odd")}.json`]);
    expect(open(dir).fold("-100:3/odd", { until: 1e9, budget: 1e9 }).text).toBe("@a (msg 1): in a topic");
  });

  it("a push writes only its own place: another place's file is not touched", () => {
    const dir = freshPath();
    const buf = open(dir);
    buf.push("busy", entry("@a", "one", 1));
    buf.push("quiet", entry("@b", "two", 1));
    const before = readFileSync(fileOf(dir, "quiet"), "utf8");
    rmSync(fileOf(dir, "quiet"));
    mkdirSync(fileOf(dir, "quiet")); // were it rewritten, the write would fail
    expect(() => buf.push("busy", entry("@a", "three", 2))).not.toThrow();
    expect(before).toContain("two");
  });

  it("fails to open, rather than starting empty, where the directory of places is a file", () => {
    const dir = freshPath();
    writeFileSync(dir, "a file where the directory should be");
    expect(() => open(dir)).toThrow(/ENOTDIR/);
  });

  it("a failed pre-ACK persist keeps nothing — memory matches disk, a redelivery re-pushes once", () => {
    const dir = freshPath();
    const buf = open(dir);
    buf.push("place", entry("@alice", "kept", 1));
    rmSync(fileOf(dir, "place"));
    mkdirSync(fileOf(dir, "place")); // make the file unwritable (rename onto a directory fails)
    expect(() => buf.push("place", entry("@bob", "rolled back", 2))).toThrow(/EISDIR/);
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
