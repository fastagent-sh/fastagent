import { describe, expect, it, vi } from "vitest";
import { type LoopHarness, type LoopLog, type LoopRun, loopPort } from "../src/loop-port.ts";
import type { HarnessPort } from "../src/harness-port.ts";
import { AgentRejection, type FollowEvent, type InvokeEvent, LIMITS, agentError, failure } from "../src/protocol.ts";
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

/** pi's gap: `steer()` resolves, but the message reaches the run only after it ended, and is never written. */
function steeringDropped(harness: LoopHarness): LoopHarness {
  const dropping = (log: LoopLog): LoopLog => ({
    ...log,
    run: (message, emit) => ({ ...log.run(message, emit), steer: async () => {} }),
  });
  return {
    ...harness,
    open: async (sessionId, onRecord) => {
      const log = await harness.open(sessionId, onRecord);
      return log && dropping(log);
    },
    create: async (sessionId, onRecord, fork) => dropping(await harness.create(sessionId, onRecord, fork)),
  };
}

/** A harness whose every loop ends before it writes its message, counting the loops it was asked to start. */
function refusingEveryMessage(
  harness: LoopHarness,
  refuse: () => LoopRun,
): { harness: LoopHarness; loops: () => number } {
  let loops = 0;
  // Past a handful, a regression would restart forever; a run that never ends stops it so the count can fail.
  const never: LoopRun = { steer: async () => {}, stop: () => {}, done: new Promise(() => {}) };
  const refusing = (log: LoopLog): LoopLog => ({
    ...log,
    run: () => (++loops > 5 ? never : refuse()),
  });
  return {
    harness: {
      ...harness,
      open: async (sessionId, onRecord) => {
        const log = await harness.open(sessionId, onRecord);
        return log && refusing(log);
      },
      create: async (sessionId, onRecord, fork) => refusing(await harness.create(sessionId, onRecord, fork)),
    },
    loops: () => loops,
  };
}

async function receiptOf(events: AsyncIterable<InvokeEvent>) {
  for await (const event of events) if (event.type === "accepted") return event;
  throw new Error("not accepted");
}

describe("LoopPort", () => {
  it("runs a joined message the harness never wrote in the same run, before it ends", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(steeringDropped(fakeLoopHarness(store))));
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
  it("a steer the harness throws on is still accepted, and the run takes the message itself", async () => {
    const store = new FakeStore();
    const harness = fakeLoopHarness(store);
    const throwing = (log: LoopLog): LoopLog => ({
      ...log,
      run: (message, emit) => ({
        ...log.run(message, emit),
        steer: () => {
          throw new Error("sync");
        },
      }),
    });
    const agent = servingAgent(
      loopPort({
        ...harness,
        open: async (sessionId, onRecord) => {
          const log = await harness.open(sessionId, onRecord);
          return log && throwing(log);
        },
        create: async (sessionId, onRecord, fork) => throwing(await harness.create(sessionId, onRecord, fork)),
      }),
    );
    const session = agent.sessions.get("s");
    const first = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }));
    await vi.waitFor(async () => expect((await session.runs.get({ runId: first.run.runId }))?.status).toBe("running"));
    const steered = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "steered" }, whenBusy: "steer" }));
    expect(steered).toMatchObject({ joined: true, run: { runId: first.run.runId } });
    store.release();
    await vi.waitFor(async () =>
      expect(await session.runs.get({ runId: first.run.runId })).toMatchObject({
        status: "done",
        answer: { text: "answer: steered" },
      }),
    );
  });

  it("a loop that ends without writing its message ends the run once, with its outcome", async () => {
    const missingModel = refusingEveryMessage(fakeLoopHarness(new FakeStore()), () => ({
      steer: async () => {},
      stop: () => {},
      done: new Promise((resolve) =>
        setTimeout(() => resolve({ outcome: { status: "failed", error: agentError("missing_model", "no model") } }), 5),
      ),
    }));
    const first = servingAgent(loopPort(missingModel.harness));
    const failed = await receiptOf(first.invoke({ sessionId: "s", prompt: { text: "x" } }));
    await vi.waitFor(async () =>
      expect(await first.sessions.get("s").runs.get({ runId: failed.run.runId })).toMatchObject({
        outcome: { status: "failed", error: { code: "missing_model" } },
      }),
    );
    expect(missingModel.loops()).toBe(1);

    const throwing = refusingEveryMessage(fakeLoopHarness(new FakeStore()), () => {
      throw new Error("cannot start");
    });
    const second = servingAgent(loopPort(throwing.harness));
    const thrown = await receiptOf(second.invoke({ sessionId: "s", prompt: { text: "x" } }));
    await vi.waitFor(async () =>
      expect(await second.sessions.get("s").runs.get({ runId: thrown.run.runId })).toMatchObject({
        outcome: { status: "failed", error: { code: "internal" } },
      }),
    );
    expect(throwing.loops()).toBe(1);
  });

  it("a run whose start the storage refused reads as interrupted, and the session goes on", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    const session = agent.sessions.get("s");
    store.refuseNext = "run_started";
    const events: InvokeEvent[] = [];
    for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "x" }, idempotencyKey: "k" })) {
      events.push(event);
    }
    // Released once its run failed to start, the session is acquired again by the stream itself, which closes the run.
    expect(events[0]).toMatchObject({ type: "accepted", run: { status: "done", outcome: { status: "interrupted" } } });
    expect(events.slice(1)).toMatchObject([
      { type: "entry", entry: { kind: "run_ended", data: { outcome: { status: "interrupted" } } } },
    ]);
    const next = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "y" } }));
    await vi.waitFor(async () =>
      expect(await session.runs.get({ runId: next.run.runId })).toMatchObject({ outcome: { status: "completed" } }),
    );
    const retried = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "x" }, idempotencyKey: "k" }));
    expect(retried.duplicate).toBe(false);
  });

  it("a run whose end the storage refused ends the streams waiting for it", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    const session = agent.sessions.get("s");
    const iterator = agent.invoke({ sessionId: "s", prompt: { text: "hold" } })[Symbol.asyncIterator]();
    const head = await iterator.next();
    const runId = head.done || head.value.type !== "accepted" ? "" : head.value.run.runId;
    await vi.waitFor(async () => expect((await session.runs.get({ runId }))?.status).toBe("running"));
    store.refuseNext = "run_ended";
    store.release();
    const rest: InvokeEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value);
    expect(rest.at(-1)?.type).toBe("serving_error");
    expect(rest.some((e) => e.type === "entry" && e.entry.kind === "run_ended")).toBe(false);
    expect(await session.runs.get({ runId })).toMatchObject({ outcome: { status: "interrupted" } });
  });

  it("closes the log when closing a previous process's runs fails", async () => {
    const store = new FakeStore();
    const before = servingAgent(loopPort(fakeLoopHarness(store)));
    const held = await receiptOf(before.invoke({ sessionId: "s", prompt: { text: "hold" } }));
    await vi.waitFor(async () =>
      expect((await before.sessions.get("s").runs.get({ runId: held.run.runId }))?.status).toBe("running"),
    );
    store.restart();
    const after = servingAgent(loopPort(fakeLoopHarness(store)));
    store.refuseNext = "run_ended";
    const refused = await after.sessions.get("s").read();
    expect(refused.ok).toBe(false);
    expect(store.openLogs).toBe(0);
    expect(await after.sessions.get("s").runs.get({ runId: held.run.runId })).toMatchObject({
      outcome: { status: "interrupted" },
    });
  });

  it("an invoke whose first record the storage refused leaves no session behind", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    store.refuseNext = "run_accepted";
    const events: InvokeEvent[] = [];
    for await (const event of agent.invoke({ sessionId: "new", prompt: { text: "x" } })) events.push(event);
    expect(events).toMatchObject([{ type: "rejected", error: { code: "internal" } }]);
    expect(await agent.sessions.list()).toEqual([]);
    expect(store.openLogs).toBe(0);
  });

  it("a harness that says its storage is unavailable reaches the caller as unavailable", async () => {
    const harness = fakeLoopHarness(new FakeStore());
    const down = new AgentRejection(agentError("unavailable", "disk busy"));
    const agent = servingAgent(loopPort({ ...harness, open: () => Promise.reject(down) }));
    const session = agent.sessions.get("s");
    const unavailable = { code: "unavailable", retryable: true, message: "disk busy" };
    await expect(session.runs.get({ runId: "r" })).rejects.toMatchObject(unavailable);
    expect(await session.read()).toEqual({ ok: false, error: unavailable });
    const events: InvokeEvent[] = [];
    for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "x" } })) events.push(event);
    expect(events).toEqual([{ type: "rejected", error: unavailable }]);
  });

  it("a withdrawal the storage refused still frees the session", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    const session = agent.sessions.get("s");
    const holder = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }));
    await vi.waitFor(async () => expect((await session.runs.get({ runId: holder.run.runId }))?.status).toBe("running"));
    const queued = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "queued" } }));
    store.refuseNext = "run_ended";
    expect(await session.runs.cancel(queued.run.runId)).toEqual({ ok: true });
    expect(await session.runs.get({ runId: queued.run.runId })).toMatchObject({ outcome: { status: "interrupted" } });
    const followed: FollowEvent[] = [];
    for await (const event of session.runs.follow(queued.run.runId)) followed.push(event);
    expect(followed).toMatchObject([{ type: "serving_error", message: expect.stringMatching(/no recorded end/) }]);
    store.release();
    const after = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "after" } }));
    await vi.waitFor(async () =>
      expect(await session.runs.get({ runId: after.run.runId })).toMatchObject({ outcome: { status: "completed" } }),
    );
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

  it("a follow whose next page the port refuses reports the port's answer, not a harness failure", async () => {
    const store = new FakeStore();
    const port = loopPort(fakeLoopHarness(store));
    const agent = servingAgent({
      ...port,
      read: async (sessionId, page) => {
        if ("after" in page && page.after !== null) return failure("not_found", `no entry ${page.after}`);
        const first = await port.read(sessionId, { ...page, limit: 1 });
        return first.ok ? { ...first, more: { ...first.more, after: true } } : first;
      },
    });
    for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "x" } })) void _;
    const events: FollowEvent[] = [];
    for await (const event of agent.sessions.get("s").follow()) {
      events.push(event);
      if (event.type === "serving_error") break;
    }
    expect(events.map((e) => e.type)).toEqual(["entry", "serving_error"]);
    expect(events[1]).toMatchObject({ message: expect.stringMatching(/^no entry e\d+$/) });
  });

  it("a read the port rejects passes its unavailable through and reports anything else as internal", async () => {
    const port = loopPort(fakeLoopHarness(new FakeStore()));
    const unavailable = new AgentRejection(agentError("unavailable", "storage is down"));
    const down = servingAgent({ ...port, list: () => Promise.reject(unavailable) });
    await expect(down.sessions.list()).rejects.toBe(unavailable);
    const broken = servingAgent({ ...port, list: () => Promise.reject(new TypeError("x is undefined")) });
    await expect(broken.sessions.list()).rejects.toMatchObject({ code: "internal", retryable: false });
  });

  it("never hands the harness a session id no URL can address", async () => {
    const port = loopPort(fakeLoopHarness(new FakeStore()));
    const untouchable = () => Promise.reject(new Error("the port was reached"));
    const agent = servingAgent({ ...port, getRun: untouchable, attachment: untouchable });
    expect(await agent.sessions.get("..").runs.get({ runId: "r" })).toBeUndefined();
    expect(await agent.sessions.get(".").attachment("ref")).toBeUndefined();
  });

  it("stops a page at the byte budget, keeping the entries nearest its cursor", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    // 1 Mi characters, 3 MiB of UTF-8: two of them fit 4 Mi characters but not 4 MiB.
    const big = "中".repeat(1 << 20);
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
