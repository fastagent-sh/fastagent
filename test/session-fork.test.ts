/**
 * A `recent` fork (session-fork.ts): the copy is the whole history, and what its model is given is bounded to the
 * newest exchanges that fit the window, counted as pi counts what reaches the model. A failed fork leaves no record.
 */
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  type PiSessionRecordStore,
  piInMemorySessionRecordStore,
  piSessionRecordStore,
} from "../src/harnesses/pi/session-store.ts";

/** Fork `from` at its head into `into`, with the `recent` window, and open the copy. */
async function forkRecent(store: PiSessionRecordStore, from: string, into: string): Promise<SessionManager> {
  const parent = await store.openIfExists(from);
  const at = parent?.getLeafId();
  if (!at) throw new Error(`${from} has no head`);
  await store.fork(from, at, into, `${from}@${at}`, "recent");
  const copy = await store.openIfExists(into);
  if (!copy) throw new Error(`${into} has no record after the fork`);
  return copy;
}

describe("the recent window", () => {
  it("a copied compaction's retained tail counts until the window cuts it; its summary is carried", async () => {
    // The tail is a POINTER on pi's compaction entry, not messages on it: the entries from `firstKeptEntryId` up to
    // the compaction still reach the model, so they count against the window (here a ~60K-token `custom_message`,
    // over the window). But pi reads only the NEWEST compaction, so the mark this places after it drops that
    // tail: charging the tail to the kept exchanges as well cut exchanges that fit, and the room's summary went too.
    const store = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const room = await store.openOrCreate("room");
    room.appendMessage({ role: "user", content: "summarized away", timestamp: 1 });
    const anchor = room.appendCustomMessageEntry("ext.dump", "T".repeat(240_000), true); // ~60K tokens
    room.appendCompaction("the older part", anchor, 1000);
    for (let i = 0; i < 3; i++) {
      room.appendMessage({ role: "user", content: `question ${i}`, timestamp: 10 + i });
      room.appendMessage(fauxAssistantMessage(`answer ${i}`));
    }

    const thread = await forkRecent(store, "room", "thread-budget");

    // Two compactions: the copied one, plus the window's mark the tail demands.
    expect(thread.getBranch().filter((e) => e.type === "compaction")).toHaveLength(2);
    const context = JSON.stringify(thread.buildSessionContext().messages);
    expect(context).not.toContain("TTTT"); // the tail is what the window cut
    expect(context).toContain("the older part"); // the room's summary survives the cut
    for (let i = 0; i < 3; i++) expect(context).toContain(`question ${i}`); // every exchange after it fits
  });

  it("a history that fits keeps the copied compaction and its tail untouched", async () => {
    const store = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const room = await store.openOrCreate("room");
    room.appendMessage({ role: "user", content: "summarized away", timestamp: 1 });
    const anchor = room.appendCustomMessageEntry("ext.dump", "kept tail", true);
    room.appendCompaction("the older part", anchor, 1000);
    room.appendMessage({ role: "user", content: "question 0", timestamp: 10 });
    room.appendMessage(fauxAssistantMessage("answer 0"));

    const thread = await forkRecent(store, "room", "thread-fits");

    expect(thread.getBranch().filter((e) => e.type === "compaction")).toHaveLength(1); // no mark placed
    const context = JSON.stringify(thread.buildSessionContext().messages);
    expect(context).toContain("kept tail");
    expect(context).toContain("the older part");
  });

  it("what pi removed from the room's context stays removed in the thread", async () => {
    const store = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const room = await store.openOrCreate("room");
    room.appendMessage({ role: "user", content: "old question", timestamp: 1 });
    room.appendMessage(fauxAssistantMessage("old answer"));
    room.appendCompaction("the summary", null, 100); // retains nothing: points at itself
    room.appendMessage({ role: "user", content: "question", timestamp: 2 });
    const abandoned = room.appendMessage(fauxAssistantMessage("abandoned attempt"));
    room.appendContextEdit(abandoned, null); // how pi drops a retried/overflowed attempt
    room.appendMessage(fauxAssistantMessage("final answer"));

    const thread = await forkRecent(store, "room", "thread-edits");

    const context = JSON.stringify(thread.buildSessionContext().messages);
    expect(context).toContain("the summary");
    expect(context).toContain("final answer");
    expect(context).not.toContain("old answer");
    expect(context).not.toContain("abandoned attempt");
  });

  it("an attempt pi omitted costs the window nothing: it never reaches the model", async () => {
    // pi 0.87 keeps an abandoned retry/overflow attempt in the journal and omits it with a `context_edit`. Measured
    // on the raw journal, one such attempt (~60K tokens here) pushed the room's earlier exchanges out of the window.
    const store = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const room = await store.openOrCreate("room");
    room.appendMessage({ role: "user", content: "question 0", timestamp: 1 });
    room.appendMessage(fauxAssistantMessage("answer 0"));
    room.appendMessage({ role: "user", content: "question 1", timestamp: 2 });
    room.appendContextEdit(room.appendMessage(fauxAssistantMessage("X".repeat(240_000))), null);
    room.appendMessage(fauxAssistantMessage("answer 1"));
    room.appendMessage({ role: "user", content: "question 2", timestamp: 3 });
    room.appendMessage(fauxAssistantMessage("answer 2"));

    const thread = await forkRecent(store, "room", "thread-omitted");

    // Everything the model sees fits, so no window is cut.
    const context = JSON.stringify(thread.buildSessionContext().messages);
    expect(context).toContain("question 0");
    expect(context).not.toContain("XXXX"); // and the attempt itself stays omitted in the thread
  });
});

describe("a fork that fails is never registered", () => {
  it("on disk: no record under the id, and nothing left in staging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-fork-partial-"));
    const cwd = process.cwd();
    const store = piSessionRecordStore({ dir, cwd });
    const room = await store.openOrCreate("room");
    room.appendMessage({ role: "user", content: "first question", timestamp: 1 });
    const at = room.appendMessage(fauxAssistantMessage("first answer"));

    // The copy blows up midway, after the staged record exists on disk and before it is published. A half-copied
    // record under the id would make which record a later lookup finds a matter of directory order. (Staging is what
    // buys that: the partial file is in a subdirectory `list()` does not read, and only a finished record is renamed
    // into place.)
    const append = vi.spyOn(SessionManager.prototype, "appendMessage").mockImplementation(() => {
      throw new Error("disk full while copying");
    });
    try {
      await expect(store.fork("room", at, "thread", "test-provenance", "recent")).rejects.toThrow("disk full");
    } finally {
      append.mockRestore();
    }

    expect(await store.openIfExists("thread")).toBeUndefined();
    expect((await store.list()).map((row) => row.sessionId)).toEqual(["room"]);
    // Nothing ever reads that directory, so a file left per failed attempt would accumulate until someone looked.
    expect(await readdir(join(dir, "agent-session", ".staging"))).toEqual([]);
  });

  it("in memory: a copy that fails mid-way registers nothing, not half a room", async () => {
    const store = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const room = await store.openOrCreate("room");
    room.appendMessage({ role: "user", content: "first", timestamp: 1 });
    room.appendMessage(fauxAssistantMessage("second"));
    const at = room.appendMessage({ role: "user", content: "third", timestamp: 3 });

    let copied = 0;
    const append = SessionManager.prototype.appendMessage;
    const spy = vi.spyOn(SessionManager.prototype, "appendMessage").mockImplementation(function (
      this: SessionManager,
      message: Parameters<SessionManager["appendMessage"]>[0],
    ) {
      if (++copied === 2) throw new Error("out of memory mid-copy"); // the second COPIED entry
      return append.call(this, message);
    });
    try {
      await expect(store.fork("room", at, "thread", "test-provenance")).rejects.toThrow("out of memory");
    } finally {
      spy.mockRestore();
    }

    expect(await store.openIfExists("thread")).toBeUndefined();
  });
});
