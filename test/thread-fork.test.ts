/** Where a new thread starts from: a fork of its room at the run its reply chain names. */
import { describe, expect, it, vi } from "vitest";
import { forkThread } from "../src/channels/kit/thread-fork.ts";
import { log } from "../src/log.ts";
import { loopPort } from "../src/loop-port.ts";
import { type Agent, type RunStatus, failure } from "../src/protocol.ts";
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
  it("forks at the answer of the first run its chain names, nearest first", async () => {
    const agent = await roomWith([
      ["m1", "first"],
      ["m2", "second"],
      ["m3", "third"],
    ]);
    // "card" is no run's message (the agent posted it), so the next one up names the run.
    await forkThread(agent, { sessionId: "thread", room: "room", chain: ["card", "m2", "m1"] }, "[test]");
    expect(await said(agent, "thread")).toEqual(["first", "second"]);
  });

  it("forks at the room's present when nothing in its chain names a run", async () => {
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

  it("a run without an answer forks at its message; a queued one at the present", async () => {
    const forks: unknown[] = [];
    const stub = (run: RunStatus) =>
      ({
        sessions: {
          get: (sessionId: string) => ({
            read: async () =>
              sessionId === "room"
                ? { ok: true, state: { status: "idle", queued: [], leafEntryId: "leaf" }, entries: [] }
                : failure("not_found", "no session"),
            runs: { get: async () => run },
          }),
          create: async (options: unknown) => {
            forks.push(options);
            return { ok: true, sessionId: "thread" };
          },
        },
      }) as unknown as Agent;
    const thread = { sessionId: "thread", room: "room", chain: ["m1"] };
    await forkThread(
      stub({ runId: "r", messages: [{ entryId: "asked" }], status: "running", startedAt: 0 }),
      thread,
      "",
    );
    await forkThread(stub({ runId: "r", messages: [{}], status: "queued", position: 1 }), thread, "");
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
