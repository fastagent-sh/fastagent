import { describe, expect, it, vi } from "vitest";
import { type LoopHarness, type LoopLog, type LoopRun, loopPort } from "../src/loop-port.ts";
import type { HarnessPort } from "../src/harness-port.ts";
import {
  AgentRejection,
  type FollowEvent,
  type InvokeEvent,
  LIMITS,
  type SessionState,
  agentError,
  failure,
} from "../src/protocol.ts";
import { LIVE_BACKLOG, servingAgent } from "../src/serving-layer.ts";
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
  late: true,
});

/** A harness that loses a steer and says nothing about it. */
function steeringDropped(harness: LoopHarness): LoopHarness {
  const dropping = (log: LoopLog): LoopLog => ({
    ...log,
    run: (message, emit) => ({ ...log.run(message, emit), steer: () => {} }),
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
  const never: LoopRun = { steer: async () => {}, withdraw: () => false, stop: () => {}, done: new Promise(() => {}) };
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

/** A message's status once it is done. */
async function doneOf(agent: ReturnType<typeof servingAgent>, sessionId: string, messageId: string) {
  return vi.waitFor(async () => {
    const status = await agent.sessions.get(sessionId).messages.get({ messageId });
    if (status?.status !== "done") throw new Error(`message ${messageId} is ${status?.status}`);
    return status;
  });
}

async function takenNow(agent: ReturnType<typeof servingAgent>, sessionId: string, messageId: string) {
  await vi.waitFor(async () =>
    expect((await agent.sessions.get(sessionId).messages.get({ messageId }))?.status).toBe("taken"),
  );
}

const usersOf = async (agent: ReturnType<typeof servingAgent>, sessionId: string) => {
  const page = await agent.sessions.get(sessionId).read({ limit: 500 });
  return page.ok ? page.entries.filter((e) => e.kind === "user_message") : [];
};

describe("LoopPort", () => {
  it("a steer the harness reports nothing for is taken by the next run, and answered on its own", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(steeringDropped(fakeLoopHarness(store))));
    const first = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    await takenNow(agent, "s", first);
    const steered = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "also" }, whenBusy: "steer" }));
    expect(steered.message).toMatchObject({ status: "queued", position: 0 });
    store.release();
    expect(await doneOf(agent, "s", first)).toMatchObject({ answer: { text: "answer: hold" } });
    const answered = await doneOf(agent, "s", steered.message.messageId);
    expect(answered).toMatchObject({ outcome: { status: "completed" }, answer: { text: "answer: also" } });
    expect((await usersOf(agent, "s")).map((e) => (e.data as { text: string }).text)).toEqual(["hold", "also"]);
  });

  it("a message an extension consumed ends intercepted, with no entry, and is not taken again", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    const first = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    await takenNow(agent, "s", first);
    const handled = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "handle" }, whenBusy: "steer" }));
    store.release();
    expect(await doneOf(agent, "s", first)).toMatchObject({
      outcome: { status: "completed" },
      answer: { text: "answer: hold" },
    });
    const consumed = await doneOf(agent, "s", handled.message.messageId);
    expect(consumed).toMatchObject({ outcome: { status: "intercepted" } });
    expect(consumed.entryId).toBeUndefined();
    expect(store.handled).toBe(1);
  });

  it("a steer the harness throws on is still accepted, and the next run takes the message", async () => {
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
    const first = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    await takenNow(agent, "s", first);
    const steered = await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "steered" }, whenBusy: "steer" }));
    store.release();
    expect(await doneOf(agent, "s", steered.message.messageId)).toMatchObject({
      answer: { text: "answer: steered" },
    });
  });

  it("a steer the harness throws on shifts nothing: each message names its own entry", async () => {
    const store = new FakeStore();
    const harness = fakeLoopHarness(store);
    const throwingOnBad = (log: LoopLog): LoopLog => ({
      ...log,
      run: (message, hooks) => {
        const run = log.run(message, hooks);
        return {
          ...run,
          steer: (steered) => {
            if (steered.prompt.text === "bad") throw new Error("sync");
            run.steer(steered);
          },
        };
      },
    });
    const agent = servingAgent(
      loopPort({
        ...harness,
        open: async (sessionId, onRecord) => {
          const log = await harness.open(sessionId, onRecord);
          return log && throwingOnBad(log);
        },
        create: async (sessionId, onRecord, fork) => throwingOnBad(await harness.create(sessionId, onRecord, fork)),
      }),
    );
    const first = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    await takenNow(agent, "s", first);
    const bad = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "bad" }, whenBusy: "steer" }))).message
      .messageId;
    const good = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "good" }, whenBusy: "steer" })))
      .message.messageId;
    store.release();
    const ids = [first, bad, good];
    const done = await Promise.all(ids.map((id) => doneOf(agent, "s", id)));
    const written = await usersOf(agent, "s");
    expect(written.map((e) => (e.data as { text: string }).text)).toEqual(["hold", "good", "bad"]);
    const byText = new Map(written.map((e) => [(e.data as { text: string }).text, e]));
    expect(done.map((m) => m.entryId)).toEqual(["hold", "bad", "good"].map((t) => byText.get(t)?.id));
    const named = ["hold", "bad", "good"].map(
      (t) => (byText.get(t)?.data as { messageId?: string } | undefined)?.messageId,
    );
    expect(named).toEqual(ids);
  });

  it("counts each message as work in flight until it ends", async () => {
    const store = new FakeStore();
    let working = 0;
    const agent = servingAgent(
      loopPort(fakeLoopHarness(store), undefined, {
        beginWork: () => {
          working++;
          let done = false;
          return () => {
            if (!done) working--;
            done = true;
          };
        },
      }),
    );
    const first = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    const queued = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "next" } }))).message.messageId;
    expect(working).toBe(2);
    store.release();
    await doneOf(agent, "s", queued);
    await vi.waitFor(() => expect(working).toBe(0));
    expect((await doneOf(agent, "s", first)).status).toBe("done");
  });

  it("a loop that ends without writing its message ends it once, with its outcome", async () => {
    const missingModel = refusingEveryMessage(fakeLoopHarness(new FakeStore()), () => ({
      steer: async () => {},
      withdraw: () => false,
      stop: () => {},
      done: new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              outcome: { status: "failed", error: agentError("missing_model", "no model") },
            }),
          5,
        ),
      ),
    }));
    const first = servingAgent(loopPort(missingModel.harness));
    const failed = await receiptOf(first.invoke({ sessionId: "s", prompt: { text: "x" } }));
    expect(await doneOf(first, "s", failed.message.messageId)).toMatchObject({
      outcome: { status: "failed", error: { code: "missing_model" } },
    });
    expect(missingModel.loops()).toBe(1);

    const throwing = refusingEveryMessage(fakeLoopHarness(new FakeStore()), () => {
      throw new Error("cannot start");
    });
    const second = servingAgent(loopPort(throwing.harness));
    const thrown = await receiptOf(second.invoke({ sessionId: "s", prompt: { text: "x" } }));
    expect(await doneOf(second, "s", thrown.message.messageId)).toMatchObject({
      outcome: { status: "failed", error: { code: "internal" } },
    });
    expect(throwing.loops()).toBe(1);
  });

  it("a taken record the storage refused: the message ends whole, and its end names its entry", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      store.refuseNext = "message_taken";
      const events: InvokeEvent[] = [];
      for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "x" } })) events.push(event);
      const done = events.at(-1);
      expect(done).toMatchObject({ type: "done", message: { outcome: { status: "completed" } } });
      const [user] = await usersOf(agent, "s");
      expect(done?.type === "done" && done.message.entryId).toBe(user?.id);
      expect((user?.data as { messageId?: string } | undefined)?.messageId).toBe(
        done?.type === "done" ? done.message.messageId : "",
      );
      const said = error.mock.calls.flat().join(" ");
      expect(said).toContain("could not record message_taken");
      expect(said).not.toContain("interrupted");
    } finally {
      error.mockRestore();
    }
  });

  it("a message whose end the storage refused ends the streams waiting for it", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    const iterator = agent.invoke({ sessionId: "s", prompt: { text: "hold" } })[Symbol.asyncIterator]();
    const head = await iterator.next();
    const messageId = head.done || head.value.type !== "accepted" ? "" : head.value.message.messageId;
    await takenNow(agent, "s", messageId);
    store.refuseNext = "message_ended";
    store.release();
    const rest: InvokeEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value);
    expect(rest.at(-1)?.type).toBe("serving_error");
    expect(rest.some((e) => e.type === "done")).toBe(false);
    expect(await agent.sessions.get("s").messages.get({ messageId })).toMatchObject({
      outcome: { status: "interrupted" },
    });
  });

  it("closes the log when ending a previous process's messages fails", async () => {
    const store = new FakeStore();
    const before = servingAgent(loopPort(fakeLoopHarness(store)));
    const held = (await receiptOf(before.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    await takenNow(before, "s", held);
    store.restart();
    const after = servingAgent(loopPort(fakeLoopHarness(store)));
    store.refuseNext = "message_ended";
    const refused = await after.sessions.get("s").read();
    expect(refused.ok).toBe(false);
    expect(store.openLogs).toBe(0);
    expect(await after.sessions.get("s").messages.get({ messageId: held })).toMatchObject({
      outcome: { status: "interrupted" },
    });
  });

  it("an invoke whose first record the storage refused leaves no session behind", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    store.refuseNext = "message_accepted";
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
    await expect(session.messages.get({ messageId: "m" })).rejects.toMatchObject(unavailable);
    expect(await session.read()).toEqual({ ok: false, error: unavailable });
    const events: InvokeEvent[] = [];
    for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "x" } })) events.push(event);
    expect(events).toEqual([{ type: "rejected", error: unavailable }]);
  });

  it("canceling a steer the loop has not taken withdraws it: canceled, no entry, never taken", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    const first = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    await takenNow(agent, "s", first);
    const steer = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "two" }, whenBusy: "steer" })))
      .message.messageId;
    expect(await agent.sessions.get("s").messages.cancel(steer)).toEqual({ ok: true });
    store.release();
    expect(await doneOf(agent, "s", first)).toMatchObject({
      outcome: { status: "completed" },
      answer: { text: "answer: hold" },
    });
    const withdrawn = await doneOf(agent, "s", steer);
    expect(withdrawn).toMatchObject({ outcome: { status: "canceled" } });
    expect(withdrawn.entryId).toBeUndefined();
    expect((await usersOf(agent, "s")).map((e) => (e.data as { text: string }).text)).toEqual(["hold"]);
  });

  it("a steer the loop can no longer take back is canceled by stopping the run it is part of", async () => {
    const store = new FakeStore();
    const harness = fakeLoopHarness(store);
    const keeping = (log: LoopLog): LoopLog => ({
      ...log,
      run: (message, hooks) => ({ ...log.run(message, hooks), withdraw: () => false }),
    });
    const agent = servingAgent(
      loopPort({
        ...harness,
        open: async (sessionId, onRecord) => {
          const log = await harness.open(sessionId, onRecord);
          return log && keeping(log);
        },
        create: async (sessionId, onRecord, fork) => keeping(await harness.create(sessionId, onRecord, fork)),
      }),
    );
    const first = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    await takenNow(agent, "s", first);
    const steer = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "two" }, whenBusy: "steer" })))
      .message.messageId;
    expect(await agent.sessions.get("s").messages.cancel(steer)).toEqual({ ok: true });
    const canceled = { outcome: { status: "canceled" } };
    expect(await doneOf(agent, "s", first)).toMatchObject(canceled);
    expect(await doneOf(agent, "s", steer)).toMatchObject(canceled);
  });

  it("an abort after a cancel withdraws the steers the canceled run had not taken", async () => {
    const store = new FakeStore();
    const harness = fakeLoopHarness(store);
    // A stop that lands only on release, so the abort arrives while the canceled run is still settling.
    const slowStop = (log: LoopLog): LoopLog => ({
      ...log,
      run: (message, hooks) => {
        const run = log.run(message, hooks);
        return { ...run, stop: () => void store.holding().then(() => run.stop()) };
      },
    });
    const agent = servingAgent(
      loopPort({
        ...harness,
        open: async (sessionId, onRecord) => {
          const log = await harness.open(sessionId, onRecord);
          return log && slowStop(log);
        },
        create: async (sessionId, onRecord, fork) => slowStop(await harness.create(sessionId, onRecord, fork)),
      }),
    );
    const session = agent.sessions.get("s");
    const first = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "late" } }))).message.messageId;
    await vi.waitFor(async () => {
      const page = await session.read();
      expect(page.ok && page.entries.some((e) => e.kind === "assistant_message")).toBe(true);
    });
    const steer = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "also" }, whenBusy: "steer" })))
      .message.messageId;
    expect(await session.messages.cancel(first)).toEqual({ ok: true });
    expect(await session.abort()).toMatchObject({ ok: true, stopped: { queued: [steer] } });
    store.release();
    expect(await doneOf(agent, "s", steer)).toMatchObject({ outcome: { status: "canceled" } });
    expect(await doneOf(agent, "s", first)).toMatchObject({ outcome: { status: "canceled" } });
  });

  it("a withdrawal the storage refused still frees the session", async () => {
    const store = new FakeStore();
    const agent = servingAgent(loopPort(fakeLoopHarness(store)));
    const session = agent.sessions.get("s");
    const holder = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    await takenNow(agent, "s", holder);
    const queued = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "queued" } }))).message.messageId;
    store.refuseNext = "message_ended";
    expect(await session.messages.cancel(queued)).toEqual({ ok: true });
    expect(await session.messages.get({ messageId: queued })).toMatchObject({ outcome: { status: "interrupted" } });
    const followed: FollowEvent[] = [];
    for await (const event of session.messages.follow(queued)) followed.push(event);
    expect(followed).toMatchObject([{ type: "serving_error", message: expect.stringMatching(/no recorded end/) }]);
    store.release();
    const after = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "after" } }))).message.messageId;
    expect(await doneOf(agent, "s", after)).toMatchObject({ outcome: { status: "completed" } });
  });
});

describe("serving layer", () => {
  it("a caller that detaches releases its subscription; the agent goes on", async () => {
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
    await doneOf(agent, "s", first.message.messageId);
  });

  it("a message taken between its status read and its backfill still streams all it is part of", async () => {
    const store = new FakeStore();
    const harness = fakeLoopHarness(store);
    // pi binds before it writes the first message: the message is taken a moment after it is accepted.
    const lateTake = (log: LoopLog): LoopLog => ({
      ...log,
      run: (message, hooks) => {
        const started = new Promise<LoopRun>((resolve) => setTimeout(() => resolve(log.run(message, hooks)), 10));
        return {
          steer: (steered) => void started.then((run) => run.steer(steered)),
          withdraw: () => false,
          stop: () => void started.then((run) => run.stop()),
          done: started.then((run) => run.done),
        };
      },
    });
    const port = loopPort({
      ...harness,
      open: async (sessionId, onRecord) => {
        const log = await harness.open(sessionId, onRecord);
        return log && lateTake(log);
      },
      create: async (sessionId, onRecord, fork) => lateTake(await harness.create(sessionId, onRecord, fork)),
    });
    // The status is read at once and answered late, after the message was taken.
    const agent = servingAgent({
      ...port,
      getMessage: async (sessionId, key) => {
        const status = await port.getMessage(sessionId, key);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return status;
      },
    });
    const kinds: string[] = [];
    const read = (async () => {
      for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "hold" } })) {
        kinds.push(event.type === "entry" ? `entry:${event.entry.kind}` : event.type);
      }
    })();
    await vi.waitFor(() => expect(kinds).toContain("entry:user_message"));
    store.release();
    await read;
    expect(kinds).toEqual(["accepted", "entry:user_message", "message_delta", "entry:assistant_message", "done"]);
  });

  it("a message taken just before its backfill streams its own part only, each entry once", async () => {
    const store = new FakeStore();
    const port = loopPort(fakeLoopHarness(store));
    let releaseBeforeRead = false;
    // The loop moves on between the steer's admission and its backfill: the first message's answer is written, then the
    // steer is taken. That answer, and its delta, come before the steer's own entry and are not the steer's.
    const agent = servingAgent({
      ...port,
      messageEntries: async (sessionId, messageId, after) => {
        if (releaseBeforeRead) {
          releaseBeforeRead = false;
          store.release();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return port.messageEntries(sessionId, messageId, after);
      },
    });
    const first = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
    await takenNow(agent, "s", first);
    releaseBeforeRead = true;
    const events: InvokeEvent[] = [];
    const read = (async () => {
      for await (const event of agent.invoke({ sessionId: "s", prompt: { text: "hold" }, whenBusy: "steer" })) {
        events.push(event);
      }
    })();
    await vi.waitFor(() => expect(events.some((e) => e.type === "entry")).toBe(true));
    store.release();
    await read;
    const steer = events[0]?.type === "accepted" ? events[0].message.messageId : "";
    const entries = events.flatMap((e) => (e.type === "entry" ? [e.entry] : []));
    expect(entries.map((e) => e.kind)).toEqual(["user_message", "assistant_message"]);
    expect((entries[0]?.data as { messageId?: string } | undefined)?.messageId).toBe(steer);
    expect(events.filter((e) => e.type === "message_delta")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", message: { messageId: steer } });
  });

  it("a follower is told when a message is taken, not only when a run starts and ends", async () => {
    const store = new FakeStore();
    // Taken a moment after it is accepted, as pi takes a message once its session is bound.
    const harness = fakeLoopHarness(store);
    const lateTake = (log: LoopLog): LoopLog => ({
      ...log,
      run: (message, hooks) => {
        const started = new Promise<LoopRun>((resolve) => setTimeout(() => resolve(log.run(message, hooks)), 10));
        return {
          steer: (steered) => void started.then((run) => run.steer(steered)),
          withdraw: () => false,
          stop: () => void started.then((run) => run.stop()),
          done: started.then((run) => run.done),
        };
      },
    });
    const late = servingAgent(
      loopPort({
        ...harness,
        open: async (sessionId, onRecord) => {
          const log = await harness.open(sessionId, onRecord);
          return log && lateTake(log);
        },
        create: async (sessionId, onRecord, fork) => lateTake(await harness.create(sessionId, onRecord, fork)),
      }),
    );
    await late.sessions.create({ sessionId: "s" });
    const states: SessionState[] = [];
    const follow = late.sessions.get("s").follow()[Symbol.asyncIterator]();
    void (async () => {
      for (let next = await follow.next(); !next.done; next = await follow.next()) {
        if (next.value.type === "state") states.push(next.value.state);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const first = await receiptOf(late.invoke({ sessionId: "s", prompt: { text: "hold" } }));
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "running",
        taken: [{ messageId: first.message.messageId }],
        queued: [],
      }),
    );
    store.release();
    await follow.return?.();
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
    const agent = servingAgent({ ...port, getMessage: untouchable, attachment: untouchable });
    expect(await agent.sessions.get("..").messages.get({ messageId: "m" })).toBeUndefined();
    expect(await agent.sessions.get(".").attachment("ref")).toBeUndefined();
  });

  it("a subscriber that falls behind reads what it missed from the log: every entry once, and the message's end", async () => {
    const saved = { ...LIVE_BACKLOG };
    LIVE_BACKLOG.events = 3;
    try {
      const agent = servingAgent(loopPort(fakeLoopHarness(new FakeStore())));
      for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "first" } })) void _;
      const session = agent.sessions.get("s");
      const follow = session.follow()[Symbol.asyncIterator]();
      const followed: FollowEvent[] = [(await follow.next()).value as FollowEvent];
      // Not read while the next messages write: this subscriber and the invoke's own both fall behind.
      const invoked = agent.invoke({ sessionId: "s", prompt: { text: "second" } })[Symbol.asyncIterator]();
      const receipt = await invoked.next();
      for (const text of ["third", "fourth"]) {
        for await (const _ of agent.invoke({ sessionId: "s", prompt: { text } })) void _;
      }
      const rest = [];
      for (let next = await invoked.next(); !next.done; next = await invoked.next()) rest.push(next.value);
      expect(receipt.value).toMatchObject({ type: "accepted" });
      expect(rest.at(-1)).toMatchObject({ type: "done" });
      const page = await session.read({ limit: 500 });
      const all = page.ok ? page.entries.map((e) => e.id) : [];
      while (followed.filter((e) => e.type === "entry").length < all.length) {
        followed.push((await follow.next()).value as FollowEvent);
      }
      // Caught up, it is live again.
      for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "fifth" } })) void _;
      const after = await session.read({ limit: 500 });
      const everything = after.ok ? after.entries.map((e) => e.id) : [];
      while (followed.filter((e) => e.type === "entry").length < everything.length) {
        followed.push((await follow.next()).value as FollowEvent);
      }
      await follow.return?.();
      expect(all.length).toBeLessThan(everything.length);
      expect(followed.filter((e) => e.type === "serving_error")).toEqual([]);
      expect(followed.flatMap((e) => (e.type === "entry" ? [e.entry.id] : []))).toEqual(everything);
    } finally {
      Object.assign(LIVE_BACKLOG, saved);
    }
  });

  it("what a lagging subscriber cannot read back is kept: the error that ends a message, and the latest state", async () => {
    const saved = { ...LIVE_BACKLOG };
    LIVE_BACKLOG.events = 2;
    try {
      const store = new FakeStore();
      const agent = servingAgent(loopPort(fakeLoopHarness(store)));
      const session = agent.sessions.get("s");
      for await (const _ of agent.invoke({ sessionId: "s", prompt: { text: "first" } })) void _;
      const follow = session.follow()[Symbol.asyncIterator]();
      await follow.next();
      // Not read while this run writes, so both the invoke's stream and the follow fall behind before its end.
      const invoked = agent.invoke({ sessionId: "s", prompt: { text: "hold" } })[Symbol.asyncIterator]();
      const receipt = await invoked.next();
      const messageId = receipt.done || receipt.value.type !== "accepted" ? "" : receipt.value.message.messageId;
      await takenNow(agent, "s", messageId);
      // A message queued behind holds the session, so nothing ends the refused one for it in the log.
      const next = (await receiptOf(agent.invoke({ sessionId: "s", prompt: { text: "hold" } }))).message.messageId;
      store.refuseNext = "message_ended";
      store.release();
      await doneOf(agent, "s", messageId);
      const rest = [];
      for (let next = await invoked.next(); !next.done; next = await invoked.next()) rest.push(next.value);
      expect(rest.at(-1)).toMatchObject({ type: "serving_error" });
      expect(rest.some((e) => e.type === "done")).toBe(false);
      await takenNow(agent, "s", next);
      store.release();
      await doneOf(agent, "s", next);
      const followed: FollowEvent[] = [];
      for (;;) {
        const next = await Promise.race([
          follow.next(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 200)),
        ]);
        if (!next || next.done) break;
        followed.push(next.value);
      }
      await follow.return?.();
      expect(followed.filter((e) => e.type === "state").at(-1)).toMatchObject({ state: { status: "idle" } });
    } finally {
      Object.assign(LIVE_BACKLOG, saved);
    }
  });

  it("an entry written between subscribing and the first read is delivered once", async () => {
    const port = loopPort(fakeLoopHarness(new FakeStore()));
    let first = true;
    const agent = servingAgent({
      ...port,
      read: async (sessionId, page) => {
        if (first) {
          first = false;
          await port.submit(sessionId, { text: "meanwhile" }, { whenBusy: "queue", source: { kind: "api" } });
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return port.read(sessionId, page);
      },
    });
    await agent.sessions.create({ sessionId: "s" });
    const follow = agent.sessions.get("s").follow()[Symbol.asyncIterator]();
    const ids: string[] = [];
    for (;;) {
      const next = await Promise.race([
        follow.next(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 200)),
      ]);
      if (!next) break;
      if (!next.done && next.value.type === "entry") ids.push(next.value.entry.id);
    }
    await follow.return?.();
    const page = await port.read("s", { after: null, limit: 500 });
    const all = page.ok ? page.entries.map((e) => e.id) : [];
    expect(all.length).toBeGreaterThan(0);
    expect(ids).toEqual(all);
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
    expect(newest.entries.map((e) => e.kind)).toEqual(["assistant_message"]);
    expect(newest.prev).toBe(newest.entries[0]?.id);
    const older = await session.read({ before: newest.prev as string });
    if (!older.ok) throw new Error(older.error.message);
    expect(older.entries.map((e) => e.kind)).toEqual(["user_message"]);
    expect(older.prev).toBeUndefined();
    expect(older.next).toBe(older.entries.at(-1)?.id);
  });
});
