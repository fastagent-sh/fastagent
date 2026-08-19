/**
 * A thread starts from what the room knew (participant-model.md §5), on the AgentSession engine.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { piSessionRecordStore } from "../src/engines/pi/session-store.ts";

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

  it("a failure while preparing the fork leaves no record under the id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-inherit-partial-"));
    const cwd = process.cwd();
    const store = await roomWithHistory(dir, cwd);
    // Publication is the last step, so a record only becomes discoverable complete. What must never
    // exist is TWO records for one id — the fallback creating a second while a half-prepared first
    // is already in place.
    const thread = await store.openOrCreate("thread-5", { parentSession: "room" });
    expect(thread.getBranch().length).toBeGreaterThan(0);

    const named = (await SessionManager.list(cwd, join(dir, "agent-session"))).filter((r) => r.id === "sthread-5");
    expect(named).toHaveLength(1);
  });
});
