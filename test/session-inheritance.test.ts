/**
 * A thread starts from what the room knew (participant-model.md §5), on the AgentSession engine.
 */
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { piInMemorySessionRecordStore, piSessionRecordStore } from "../src/engines/pi/session-store.ts";

const text = (session: SessionManager) => JSON.stringify(session.getBranch());

/** A room with two exchanges, the second mentioning a locatable marker. */
async function roomWithHistory(dir: string, cwd: string) {
  const store = piSessionRecordStore({ dir, cwd });
  const room = await store.openOrCreate("room");
  room.appendMessage({ role: "user", content: "first question", timestamp: 1 });
  room.appendMessage(fauxAssistantMessage("first answer"));
  room.appendMessage({ role: "user", content: "second question [msg-42]", timestamp: 3 });
  room.appendMessage(fauxAssistantMessage("second answer"));
  return store;
}

describe("session inheritance", () => {
  it("a new thread inherits the room's history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-inherit-"));
    const cwd = process.cwd();
    const store = await roomWithHistory(dir, cwd);

    const thread = await store.openOrCreate("thread-1", { parentSession: "room" });

    expect(text(thread)).toContain("first answer");
    expect(text(thread)).toContain("second answer");
  });

  it("branch hints cut the inheritance at the exchange they name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-inherit-hint-"));
    const cwd = process.cwd();
    const store = await roomWithHistory(dir, cwd);

    const thread = await store.openOrCreate("thread-2", { parentSession: "room", branchHints: ["msg-42"] });

    // Forked at the hinted exchange, extended forward to its answer — a question without its answer
    // would be no inheritance at all.
    expect(text(thread)).toContain("second question");
    expect(text(thread)).toContain("second answer");
  });

  it("inheritance is one-time: the second turn opens the thread, it does not re-fork", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-inherit-once-"));
    const cwd = process.cwd();
    const store = await roomWithHistory(dir, cwd);

    const first = await store.openOrCreate("thread-3", { parentSession: "room" });
    first.appendMessage({ role: "user", content: "thread's own message", timestamp: 5 });
    // The room says more AFTER the thread branched off.
    (await store.openOrCreate("room")).appendMessage({ role: "user", content: "later room talk", timestamp: 6 });

    const again = await store.openOrCreate("thread-3", { parentSession: "room" });

    expect(text(again)).toContain("thread's own message");
    expect(text(again)).not.toContain("later room talk"); // the room moved on; the thread did not
  });

  it("a parent that does not exist starts the thread empty rather than failing its first turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-inherit-missing-"));
    const store = piSessionRecordStore({ dir, cwd: process.cwd() });

    const thread = await store.openOrCreate("orphan", { parentSession: "no-such-room" });

    expect(thread.getBranch()).toHaveLength(0);
  });

  it("the fork leaves no intermediate record behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-inherit-clean-"));
    const cwd = process.cwd();
    const store = await roomWithHistory(dir, cwd);

    await store.openOrCreate("thread-4", { parentSession: "room" });

    const ids = (await SessionManager.list(cwd, join(dir, "agent-session"))).map((r) => r.id).sort();
    expect(ids).toEqual(["sroom", "sthread-4"]);
  });
});

describe("the in-memory backend inherits too — the contract is not the medium", () => {
  const memoryRoom = async () => {
    const store = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const room = await store.openOrCreate("room");
    room.appendMessage({ role: "user", content: "first question", timestamp: 1 });
    room.appendMessage(fauxAssistantMessage("the room answered 47"));
    return store;
  };

  it("a thread inherits the room's history", async () => {
    const store = await memoryRoom();
    const thread = await store.openOrCreate("thread", { parentSession: "room" });
    expect(text(thread)).toContain("the room answered 47");
  });

  it("inheritance is one-time here as well", async () => {
    const store = await memoryRoom();
    const first = await store.openOrCreate("thread", { parentSession: "room" });
    first.appendMessage({ role: "user", content: "the thread's own message", timestamp: 5 });
    (await store.openOrCreate("room")).appendMessage({ role: "user", content: "later room talk", timestamp: 6 });

    const again = await store.openOrCreate("thread", { parentSession: "room" });

    expect(text(again)).toContain("the thread's own message");
    expect(text(again)).not.toContain("later room talk");
  });

  it("a parent it does not hold starts the thread empty rather than failing", async () => {
    const store = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const thread = await store.openOrCreate("orphan", { parentSession: "no-such-room" });
    expect(thread.getBranch()).toHaveLength(0);
  });
});

describe("inheritance edges", () => {
  it("a parent that crashed mid tool-call does not pass the dangling call to the thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-inherit-crash-"));
    const cwd = process.cwd();
    const store = piSessionRecordStore({ dir, cwd });
    const room = await store.openOrCreate("room");
    room.appendMessage({ role: "user", content: "do the thing", timestamp: 1 });
    // The shape a crash leaves behind: an assistant tool_use with no result after it.
    room.appendMessage({
      ...fauxAssistantMessage(""),
      content: [{ type: "toolCall", id: "call-1", name: "doer", arguments: {} }],
      stopReason: "toolUse",
    } as never);

    const thread = await store.openOrCreate("thread", { parentSession: "room" });

    const repaired = thread.getBranch().filter((e) => JSON.stringify(e).includes("interrupted-tool-call"));
    expect(repaired).toHaveLength(1); // the thread starts on a transcript a provider will accept
  });

  it("the window's budget counts the copied compaction's retained tail", async () => {
    // The tail is a POINTER on pi's compaction entry, not messages on it, so a budget that reads the
    // entry alone saw only the summary — and admitted a window on top of a tail that can be the
    // engine's whole `keepRecentTokens` (20K by default), blowing past INHERIT_MAX_TOKENS. Here the
    // tail is a `custom_message`, which reaches the model exactly like a message and was likewise
    // uncounted.
    const store = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const room = await store.openOrCreate("room");
    room.appendMessage({ role: "user", content: "summarized away", timestamp: 1 });
    const anchor = room.appendCustomMessageEntry("ext.dump", "T".repeat(240_000), true); // ~60K tokens
    room.appendCompaction("the older part", anchor, 1000);
    for (let i = 0; i < 3; i++) {
      room.appendMessage({ role: "user", content: `question ${i}`, timestamp: 10 + i });
      room.appendMessage(fauxAssistantMessage(`answer ${i}`));
    }

    const thread = await store.openOrCreate("thread-budget", { parentSession: "room" });

    // Two compactions: the copied one, plus the inheritance mark the budget now demands.
    expect(thread.getBranch().filter((e) => e.type === "compaction")).toHaveLength(2);
    const context = JSON.stringify(thread.buildSessionContext().messages);
    expect(context).toContain("answer 2"); // the newest exchange is the window's floor
    expect(context).not.toContain("question 0"); // …and the older ones are outside it
  });

  it("a failure while preparing the fork leaves no record under the id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-inherit-partial-"));
    const cwd = process.cwd();
    const store = await roomWithHistory(dir, cwd);

    // The copy blows up midway — after the staged record exists on disk, before it is published.
    // The thread must fall back to an empty session AND leave exactly one record behind: a
    // half-prepared one under the same id would make which record a later lookup finds a matter of
    // directory order. (Staging is what buys that: the partial file is in a subdirectory `list()`
    // does not read, and only a completed record is renamed into place.)
    const append = vi.spyOn(SessionManager.prototype, "appendMessage").mockImplementation(() => {
      throw new Error("disk full while copying");
    });
    let thread: SessionManager;
    try {
      thread = await store.openOrCreate("thread-5", { parentSession: "room" });
    } finally {
      append.mockRestore();
    }

    expect(thread.getBranch()).toHaveLength(0); // started empty, as the fallback promises
    const named = (await SessionManager.list(cwd, join(dir, "agent-session"))).filter((r) => r.id === "sthread-5");
    expect(named).toHaveLength(1);
    // …and staging is EMPTY: the partial file is removed on the way out. Nothing ever reads that
    // directory, so a file left per failed attempt would accumulate until someone looked.
    expect(await readdir(join(dir, "agent-session", ".staging"))).toEqual([]);

    // And the thread is usable afterwards: the second open continues THAT record, not a third one.
    thread.appendMessage({ role: "user", content: "after the failure", timestamp: 9 });
    const again = await store.openOrCreate("thread-5");
    expect(JSON.stringify(again.getBranch())).toContain("after the failure");
  });
});

describe("a half-inherited thread is never registered", () => {
  it("in memory: a copy that fails mid-way leaves an EMPTY session, not a partial one", async () => {
    const store = piInMemorySessionRecordStore({ cwd: process.cwd() });
    const room = await store.openOrCreate("room");
    room.appendMessage({ role: "user", content: "first", timestamp: 1 });
    room.appendMessage(fauxAssistantMessage("second"));
    room.appendMessage({ role: "user", content: "third", timestamp: 3 });

    // Fail after some entries have already been copied — the state the "starting empty" warn claims
    // did not happen.
    let copied = 0;
    const append = SessionManager.prototype.appendMessage;
    const spy = vi.spyOn(SessionManager.prototype, "appendMessage").mockImplementation(function (
      this: SessionManager,
      message: Parameters<SessionManager["appendMessage"]>[0],
    ) {
      if (++copied === 2) throw new Error("out of memory mid-copy"); // the second COPIED entry
      return append.call(this, message);
    });
    let thread: SessionManager;
    try {
      thread = await store.openOrCreate("thread", { parentSession: "room" });
    } finally {
      spy.mockRestore();
    }

    expect(thread.getBranch()).toHaveLength(0); // empty, as promised — not half a room
    // And the registered session is that same empty one, so the next open continues it.
    expect((await store.openOrCreate("thread")).getBranch()).toHaveLength(0);
  });
});
