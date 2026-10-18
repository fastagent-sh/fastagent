/** Where a new thread starts from: a fork of its room at the message its reply chain names. */
import { describe, expect, it, vi } from "vitest";
import { forkThread } from "../src/channels/kit/thread-fork.ts";
import { log } from "../src/log.ts";
import { loopPort } from "../src/loop-port.ts";
import { type Agent, type MessageStatus, failure } from "../src/protocol.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { FakeStore, fakeLoopHarness } from "./fake-loop-harness.ts";

const roomWith = async (asks: [key: string, text: string][]) => {
  const agent = servingAgent(loopPort(fakeLoopHarness(new FakeStore())));
  for (const [idempotencyKey, text] of asks) {
    for await (const _ of agent.invoke({ sessionId: "room", idempotencyKey, prompt: { text } })) {
    }
  }
  return agent;
};

const said = async (agent: Agent, sessionId: string) => {
  const page = await agent.sessions.get(sessionId).read();
  return page.ok
    ? page.entries.filter((e) => e.kind === "user_message").map((e) => (e.data as { text: string }).text)
    : [];
};

describe("forkThread", () => {
  it("forks at the answer of the first message its chain names, nearest first", async () => {
    const agent = await roomWith([
      ["m1", "first"],
      ["m2", "second"],
      ["m3", "third"],
    ]);
    // "card" is no message the channel invoked with (the agent posted it), so the next one up names one.
    await forkThread(agent, { sessionId: "thread", room: "room", chain: ["card", "m2", "m1"] }, "[test]");
    expect(await said(agent, "thread")).toEqual(["first", "second"]);
  });

  it("forks at the room's present when nothing in its chain names a message", async () => {
    const agent = await roomWith([
      ["m1", "first"],
      ["m2", "second"],
    ]);
    await forkThread(agent, { sessionId: "thread", room: "room", chain: ["someone-else"] }, "[test]");
    expect(await said(agent, "thread")).toEqual(["first", "second"]);
  });

  it("leaves a thread that exists alone", async () => {
    const agent = await roomWith([["m1", "first"]]);
    await agent.sessions.create({ sessionId: "thread" });
    await forkThread(agent, { sessionId: "thread", room: "room", chain: ["m1"] }, "[test]");
    expect(await said(agent, "thread")).toEqual([]);
  });

  it("a room with no session leaves the thread empty, and says so", async () => {
    const agent = await roomWith([]);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await forkThread(agent, { sessionId: "thread", room: "room", chain: [] }, "[test]");
      expect(warn.mock.calls.flat().join(" ")).toContain("names room, which has no session");
      expect((await agent.sessions.get("thread").read({ limit: 0 })).ok).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("a message without an answer forks at its own entry; a queued one at the present", async () => {
    const forks: unknown[] = [];
    const stub = (message: MessageStatus) =>
      ({
        sessions: {
          get: (sessionId: string) => ({
            read: async () =>
              sessionId === "room"
                ? { ok: true, state: { status: "idle", taken: [], queued: [], leafEntryId: "leaf" }, entries: [] }
                : failure("not_found", "no session"),
            messages: { get: async () => message },
          }),
          create: async (options: unknown) => {
            forks.push(options);
            return { ok: true, sessionId: "thread" };
          },
        },
      }) as unknown as Agent;
    const thread = { sessionId: "thread", room: "room", chain: ["m1"] };
    await forkThread(stub({ messageId: "m", entryId: "asked", status: "taken", takenAt: 0 }), thread, "");
    await forkThread(stub({ messageId: "m", status: "queued", position: 0 }), thread, "");
    expect(forks).toEqual([
      { sessionId: "thread", fork: { sessionId: "room", entryId: "asked", context: "recent" } },
      { sessionId: "thread", fork: { sessionId: "room", context: "recent" } },
    ]);
  });

  it("a thread whose own read fails is an error, never taken for one that exists", async () => {
    const down = {
      sessions: { get: () => ({ read: async () => failure("unavailable", "the store is down") }) },
    } as unknown as Agent;
    await expect(forkThread(down, { sessionId: "thread", room: "room", chain: [] }, "[test]")).rejects.toThrow(
      "reading session thread failed: the store is down",
    );
  });
});
