import { describe, expect, it, vi } from "vitest";
import { type LoopHarness, type LoopLog, loopPort } from "../src/loop-port.ts";
import type { HarnessPort } from "../src/harness-port.ts";
import { type InvokeEvent, LIMITS } from "../src/protocol.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { FakeStore, fakeLoopHarness } from "./fake-loop-harness.ts";
import { describeProtocolConformance } from "./protocol-conformance.ts";

let store = new FakeStore();

describeProtocolConformance("LoopPort over a fake loop harness", {
  start: ({ capacity } = {}) => {
    store = new FakeStore();
    return servingAgent(
      loopPort(fakeLoopHarness(store), {
        queuedPerSession: LIMITS.queuedPerSession,
        inFlightPerProcess: capacity ?? LIMITS.inFlightPerProcess,
      }),
    );
  },
  restart: () => {
    store.restart();
    return servingAgent(loopPort(fakeLoopHarness(store)));
  },
  release: () => store.release(),
  effects: () => store.effects,
});

function steeringArrivesLate(harness: LoopHarness): LoopHarness {
  const late = (log: LoopLog): LoopLog => ({
    ...log,
    run: (message, emit) => {
      const run = log.run(message, emit);
      return {
        ...run,
        steer: async () => {
          await run.done;
          return "too_late" as const;
        },
      };
    },
  });
  return {
    ...harness,
    open: async (sessionId, onRecord) => {
      const log = await harness.open(sessionId, onRecord);
      return log && late(log);
    },
    create: async (sessionId, onRecord, fork) => late(await harness.create(sessionId, onRecord, fork)),
  };
}

async function receiptOf(events: AsyncIterable<InvokeEvent>) {
  for await (const event of events) if (event.type === "accepted") return event;
  throw new Error("not accepted");
}

describe("LoopPort", () => {
  it("runs a joined message the harness took too late in the same run, before it ends", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(steeringArrivesLate(fakeLoopHarness(store))));
    const session = agent.sessions.get("s");
    const first = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }));
    await vi.waitFor(async () => expect((await session.runs.get({ runId: first.run.runId }))?.status).toBe("running"));
    const steered = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "late" }, whenBusy: "steer" }));
    expect(steered).toMatchObject({ joined: true, run: { runId: first.run.runId } });
    store.release();
    const run = await vi.waitFor(async () => {
      const status = await session.runs.get({ runId: first.run.runId });
      if (status?.status !== "done") throw new Error("not done");
      return status;
    });
    expect(run).toMatchObject({ outcome: { status: "completed" }, answer: { text: "answer: late" } });
    expect(run.messages.map((m) => m.entryId !== undefined)).toEqual([true, true]);
    const page = await session.read();
    const ends = page.ok ? page.entries.filter((e) => e.kind === "run_ended") : [];
    expect(ends).toHaveLength(1);
  });
});

describe("serving layer", () => {
  it("a caller that detaches releases its subscription; the run goes on", async () => {
    const store = new FakeStore();
    const port = loopPort(fakeLoopHarness(store));
    let watching = 0;
    const counted: HarnessPort = {
      ...port,
      watch: (sessionId, listener) => {
        watching++;
        const unwatch = port.watch(sessionId, listener);
        return () => {
          watching--;
          unwatch();
        };
      },
    };
    const agent = servingAgent(counted);
    const first = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }));
    await vi.waitFor(() => expect(watching).toBe(0));
    store.release();
    await vi.waitFor(async () =>
      expect(await agent.sessions.get("s").runs.get({ runId: first.run.runId })).toMatchObject({ status: "done" }),
    );
  });

  it("stops a page at the byte budget, keeping the entries nearest its cursor", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    const big = "x".repeat(3 << 20);
    for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: big } })) void _;
    const session = agent.sessions.get("s");
    const newest = await session.read();
    if (!newest.ok) throw new Error(newest.error.message);
    expect(newest.entries.map((e) => e.kind)).toEqual(["assistant_message", "run_ended"]);
    expect(newest.prev).toBe(newest.entries[0]?.id);
    const older = await session.read({ before: newest.prev as string });
    if (!older.ok) throw new Error(older.error.message);
    expect(older.entries.map((e) => e.kind)).toEqual(["run_started", "user_message"]);
    expect(older.prev).toBeUndefined();
    expect(older.next).toBe(older.entries.at(-1)?.id);
  });
});
