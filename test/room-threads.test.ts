import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ThreadSummary,
  createRoomThreads,
  registerRoomThreads,
  roomThreads,
  threadList,
} from "../src/channels/kit/room-threads.ts";
import { resolveStateRoot } from "../src/paths.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An agent directory with a channel of `kind` mounted on it, and the tool context of a turn in `session`. */
function mounted(kind: string) {
  const cwd = mkdtempSync(join(tmpdir(), "room-threads-"));
  dirs.push(cwd);
  const reader = { list: vi.fn(async (room: string) => `threads of ${room}`), read: vi.fn(async () => "a thread") };
  const rooms = createRoomThreads(reader);
  registerRoomThreads(kind, resolveStateRoot(cwd), rooms);
  const ctx = (session: string) => ({ cwd, sessionManager: { getSessionId: () => session } });
  return { cwd, reader, rooms, ctx };
}

describe("room threads: what a thread tool may read", () => {
  it("reads the room the channel entered for the tool's own session, and nothing once the turn has left", async () => {
    const { reader, rooms, ctx } = mounted("chat-a");
    const leave = rooms.enter("session-1", "room-1");
    expect(await roomThreads("chat-a", ctx("session-1")).list()).toBe("threads of room-1");
    await roomThreads("chat-a", ctx("session-1")).read("t-9");
    expect(reader.read).toHaveBeenCalledWith("room-1", "t-9");
    leave();
    expect(() => roomThreads("chat-a", ctx("session-1"))).toThrow(
      "this turn was not asked in a chat-a group chat: threads are read only from the group a turn was asked in",
    );
  });

  it("refuses a turn of another session, an agent no channel serves here, and a tool with no session", () => {
    const { cwd, rooms, ctx } = mounted("chat-b");
    rooms.enter("session-1", "room-1");
    expect(() => roomThreads("chat-b", ctx("session-2"))).toThrow("was not asked in a chat-b group chat");
    expect(() => roomThreads("chat-b", { cwd })).toThrow("was not asked in a chat-b group chat");
    expect(() => roomThreads("chat-unmounted", ctx("session-1"))).toThrow(
      "no chat-unmounted channel is serving this agent in this process: threads are read only in a chat turn",
    );
  });

  it("lists threads newest first by the time shown, at most 20, saying how many it left out", () => {
    const thread = (i: number, over: Partial<ThreadSummary> = {}): ThreadSummary => ({
      id: `t${i}`,
      time: { at: Date.UTC(2026, 9, 7, 12, i), is: "last active" },
      first: { label: "Alice", text: `topic\n${i}` },
      ...over,
    });
    expect(threadList([], "this chat's newest 50 messages")).toBe("No threads among this chat's newest 50 messages.");
    const lines = threadList(
      [thread(1, { replies: 1 }), thread(3, { replies: 2 }), ...Array.from({ length: 20 }, (_, i) => thread(-i - 1))],
      "this channel's newest 100 messages",
    ).split("\n");
    expect(lines[0]).toBe(
      "Threads in this room, newest first by the time shown (among this channel's newest 100 messages). Pass a thread's id to read it.",
    );
    expect(lines[1]).toBe("- thread t3 (2 replies, last active 2026-10-07 12:03 UTC): Alice: topic 3");
    expect(lines[2]).toBe("- thread t1 (1 reply, last active 2026-10-07 12:01 UTC): Alice: topic 1");
    expect(lines).toHaveLength(1 + 20 + 1);
    expect(lines.at(-1)).toBe("(2 more not listed)");
  });

  it("a thread known only by when it started says so, and the list warns that it may have gone on", () => {
    const lines = threadList(
      [
        {
          id: "old",
          time: { at: Date.UTC(2026, 9, 4), is: "started" },
          first: { label: "Alice", text: "deploy failed" },
        },
        { id: "new", time: { at: Date.UTC(2026, 9, 6), is: "started" }, first: { label: "Bob", text: "lunch?" } },
      ],
      "this chat's newest 50 messages",
    ).split("\n");
    expect(lines.slice(1)).toEqual([
      "A thread shown by when it started may have later replies this list cannot see: read it.",
      "- thread new (started 2026-10-06 00:00 UTC): Bob: lunch?",
      "- thread old (started 2026-10-04 00:00 UTC): Alice: deploy failed",
    ]);
  });
});
