/** The temporary v0.1 adapter over the v1 Agent (removed in step 4, PR 4b): its event mapping and v0.1's own rules. */
import { describe, expect, it, vi } from "vitest";
import { type AgentEvent, SESSION_BUSY_CODE } from "../src/agent.ts";
import type { HarnessPort } from "../src/harness-port.ts";
import { dispatchStop } from "../src/channels/kit/stop-command.ts";
import { branchPoint, forkThread } from "../src/channels/kit/thread-fork.ts";
import { log } from "../src/log.ts";
import { legacyAgent } from "../src/legacy-agent.ts";
import { loopPort } from "../src/loop-port.ts";
import { type Agent, type Entry, failure, LIMITS } from "../src/protocol.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { FakeStore, fakeLoopHarness } from "./fake-loop-harness.ts";

const agentOver = (store = new FakeStore()) => {
  const v1 = servingAgent(loopPort(fakeLoopHarness(store)));
  return { v1, legacy: legacyAgent(v1, { kind: "channel", name: "test" }), store };
};

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("legacyAgent", () => {
  it("speaks v0.1: text deltas, then one terminal; the run records its channel source", async () => {
    const { v1, legacy } = agentOver();
    const events = await drain(legacy.invoke({ session: "s" }, { text: "hi" }));
    expect(events.map((e) => e.type)).toEqual(["text", "completed"]);
    const page = await v1.sessions.get("s").read();
    const runId = page.ok ? page.entries.find((e) => e.kind === "run_started")?.runId : undefined;
    expect(await v1.sessions.get("s").runs.get({ runId: runId as string })).toMatchObject({
      source: { kind: "channel", name: "test" },
    });
  });

  it("a failed run is one failed terminal, carrying its code", async () => {
    const { legacy } = agentOver();
    const events = await drain(legacy.invoke({ session: "s" }, { text: "fail" }));
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "model_error" });
  });

  it("a caller that stops reading cancels the run, as v0.1 promised", async () => {
    const { v1, legacy } = agentOver();
    const iterator = legacy.invoke({ session: "s" }, { text: "hold" })[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(async () => {
      const state = await v1.sessions.get("s").read({ limit: 0 });
      expect(state.ok && state.state.status).toBe("running");
    });
    await iterator.return?.();
    await first;
    await vi.waitFor(async () => {
      const now = await v1.sessions.get("s").read();
      const end = now.ok ? now.entries.find((e) => e.kind === "run_ended") : undefined;
      expect(end?.data).toMatchObject({ outcome: { status: "canceled", by: "cancel" } });
    });
  });

  it("a caller that stops reading before the run is accepted still cancels it", async () => {
    const { v1, legacy } = agentOver();
    const iterator = legacy.invoke({ session: "s" }, { text: "hold" })[Symbol.asyncIterator]();
    const first = iterator.next();
    await iterator.return?.();
    await first;
    await vi.waitFor(async () => {
      const now = await v1.sessions.get("s").read();
      const end = now.ok ? now.entries.find((e) => e.kind === "run_ended") : undefined;
      expect(end?.data).toMatchObject({ outcome: { status: "canceled", by: "cancel" } });
    });
  });

  it("a new thread naming its room starts as a fork of it, at the exchange its hint names", async () => {
    const { v1, legacy } = agentOver();
    await drain(legacy.invoke({ session: "room" }, { text: "msg-1 first" }));
    await drain(legacy.invoke({ session: "room" }, { text: "msg-2 second" }));
    await drain(legacy.invoke({ session: "thread", parentSession: "room", branchHints: ["msg-1"] }, { text: "reply" }));
    const page = await v1.sessions.get("thread").read();
    const said = page.ok ? page.entries.filter((e) => e.kind === "user_message").map((e) => e.data) : [];
    expect(said).toEqual([{ text: "msg-1 first" }, { text: "reply" }]);
  });
});

describe("legacyAgent and the session's listeners", () => {
  it("each turn releases its listener, whether its run ended, it was refused, or its caller stopped at the end", async () => {
    const store = new FakeStore();
    // No queue: a message for a running session is refused.
    const port = loopPort(fakeLoopHarness(store), {
      queuedPerSession: 0,
      inFlightPerProcess: LIMITS.inFlightPerProcess,
    });
    let listening = 0;
    const counted: HarnessPort = {
      ...port,
      watch: (sessionId, listener) => {
        listening++;
        const stop = port.watch(sessionId, listener);
        return () => {
          listening--;
          stop();
        };
      },
    };
    const v1 = servingAgent(counted);
    const legacy = legacyAgent(v1, { kind: "channel", name: "test" });
    for (let i = 0; i < 5; i++) await drain(legacy.invoke({ session: "s" }, { text: `turn ${i}` }));
    expect(listening).toBe(0);

    // Refused: the session is running, and there is no room to queue.
    const running = v1.invoke({ sessionId: "busy", prompt: { text: "hold" } })[Symbol.asyncIterator]();
    await running.next();
    expect(await drain(legacy.invoke({ session: "busy" }, { text: "fire" }))).toMatchObject([
      { type: "failed", code: SESSION_BUSY_CODE },
    ]);
    store.release();
    await running.return?.();
    expect(listening).toBe(0);

    // A caller that reads up to the terminal and then simply stops asking.
    const iterator = legacy.invoke({ session: "s" }, { text: "last" })[Symbol.asyncIterator]();
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      if (next.value.type === "completed") break;
    }
    expect(listening).toBe(0);
  });
});

describe("a thread far back in a long room", () => {
  it("forks at the exchange its hint names, however many pages of history came after it", async () => {
    const { v1, legacy } = agentOver();
    // More than one page (LIMITS.readMax entries): the hint's exchange is only on the oldest one.
    await drain(legacy.invoke({ session: "room" }, { text: "msg-first the start" }));
    for (let i = 0; i < Math.ceil(LIMITS.readMax / 4) + 10; i++) {
      await drain(legacy.invoke({ session: "room" }, { text: `later ${i}` }));
    }
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await drain(
        legacy.invoke({ session: "thread", parentSession: "room", branchHints: ["msg-first"] }, { text: "reply" }),
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    const page = await v1.sessions.get("thread").read({ limit: LIMITS.readMax });
    const said = page.ok ? page.entries.filter((e) => e.kind === "user_message").map((e) => e.data) : [];
    expect(said).toEqual([{ text: "msg-first the start" }, { text: "reply" }]);
  });
});

describe("branchPoint", () => {
  const entry = (id: string, kind: string, text = ""): Entry => ({ id, timestamp: 0, kind, data: { text } });
  const path = [
    entry("a", "user_message", "msg-1"),
    entry("b", "assistant_message", "one"),
    entry("c", "run_ended"),
    entry("d", "user_message", "msg-2"),
    entry("e", "assistant_message", "two"),
  ];
  it("cuts after the exchange the newest matching hint is in, at its last conversation entry", () => {
    expect(branchPoint(path, ["msg-1"])).toBe("b");
    expect(branchPoint(path, ["msg-2"])).toBe("e");
  });
  it("names nothing when no hint matches", () => {
    expect(branchPoint(path, ["msg-9"])).toBeUndefined();
  });
});

describe("dispatchStop", () => {
  it("stops the running run and says so; then says nothing is running", async () => {
    const { v1 } = agentOver();
    const first = v1.invoke({ sessionId: "s", prompt: { text: "hold" } })[Symbol.asyncIterator]();
    await first.next();
    await vi.waitFor(async () => {
      const state = await v1.sessions.get("s").read({ limit: 0 });
      expect(state.ok && state.state.status).toBe("running");
    });
    expect(await dispatchStop(v1, "s", "[test]")).toBe("⏹ Stopped.");
    await vi.waitFor(async () => expect(await dispatchStop(v1, "s", "[test]")).toBe("Nothing is running."));
    expect(await dispatchStop(v1, "never-used", "[test]")).toBe("Nothing is running.");
    await first.return?.();
  });
});

describe("forkThread", () => {
  it("with no hint, forks at the room's present from its state alone, never reading its history", async () => {
    const { v1 } = agentOver();
    await drain(legacyAgent(v1).invoke({ session: "room" }, { text: "one" }));
    await drain(legacyAgent(v1).invoke({ session: "room" }, { text: "two" }));
    const reads: { limit?: number }[] = [];
    const counting = {
      ...v1,
      sessions: {
        ...v1.sessions,
        get: (id: string) => {
          const session = v1.sessions.get(id);
          return {
            ...session,
            read: (options?: { limit?: number }) => {
              if (id === "room") reads.push(options ?? {});
              return session.read(options);
            },
          };
        },
      },
    } as Agent;
    await forkThread(counting, "thread", "room", [], "[test]");
    expect(reads).toEqual([{ limit: 0 }]);
    const page = await v1.sessions.get("thread").read();
    const said = page.ok ? page.entries.filter((e) => e.kind === "user_message").map((e) => e.data) : [];
    expect(said).toEqual([{ text: "one" }, { text: "two" }]);
  });

  it("a thread whose own read fails is an error, never taken for one that exists", async () => {
    const down = {
      sessions: { get: () => ({ read: async () => failure("unavailable", "the store is down") }) },
    } as unknown as Agent;
    await expect(forkThread(down, "thread", "room", [], "[test]")).rejects.toThrow(
      "reading session thread failed: the store is down",
    );
  });

  it("a parent with no session leaves the thread empty, and says so", async () => {
    const { v1 } = agentOver();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await forkThread(v1, "thread", "room", [], "[test]");
      expect(warn.mock.calls.flat().join(" ")).toContain("names room, which has no session");
      const own = await v1.sessions.get("thread").read({ limit: 0 });
      expect(own.ok).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
