/**
 * SPEC v1 conformance (docs/SPEC-v1.md §8), runnable against any `Agent`. Everything harness-specific comes from the
 * subject; what a run does is chosen by its message (`hold`, `fail`, `effect`, or any other text, answered
 * `answer: <text>`), which a subject maps onto its harness.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent, Entry, FollowEvent, InvokeEvent, RunStatus, Session } from "../src/protocol.ts";

export interface ProtocolSubject {
  /** A fresh agent over fresh storage. `capacity` lowers the runs a process holds in flight. */
  start(options?: { capacity?: number }): Agent | Promise<Agent>;
  /** The same storage, opened by a new process; the previous agent is abandoned mid-work. */
  restart(): Agent | Promise<Agent>;
  /** Lets every `hold` run of the current process go on. */
  release(): void;
  /** How many times an `effect` run's tool has run. */
  effects(): number;
}

async function drain<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** The first event, and the rest still being read: what a caller holds while it acts on a live stream. */
async function opened<T>(events: AsyncIterable<T>): Promise<{ first: T; rest: Promise<T[]> }> {
  const iterator = events[Symbol.asyncIterator]();
  const head = await iterator.next();
  if (head.done) throw new Error("the stream ended before its first event");
  const rest = (async () => {
    const out: T[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) out.push(next.value);
    return out;
  })();
  return { first: head.value, rest };
}

/** Read up to and including the receipt, leaving the rest unread: the caller detaches. */
async function receipt(
  events: AsyncIterable<InvokeEvent>,
): Promise<Extract<InvokeEvent, { type: "accepted" | "rejected" }>> {
  for await (const event of events) {
    if (event.type === "accepted" || event.type === "rejected") return event;
  }
  throw new Error("the stream ended without a receipt");
}

function accepted(event: InvokeEvent): Extract<InvokeEvent, { type: "accepted" }> {
  if (event.type !== "accepted") throw new Error(`expected accepted, got ${JSON.stringify(event)}`);
  return event;
}

function rejected(event: InvokeEvent | FollowEvent): Extract<InvokeEvent, { type: "rejected" }> {
  if (event.type !== "rejected") throw new Error(`expected rejected, got ${JSON.stringify(event)}`);
  return event;
}

const entriesOf = (events: (InvokeEvent | FollowEvent)[]): Entry[] =>
  events.flatMap((event) => (event.type === "entry" ? [event.entry] : []));

const answerOf = (events: InvokeEvent[]): string | undefined =>
  entriesOf(events)
    .filter((entry) => entry.kind === "assistant_message")
    .map((entry) => (entry.data as { text: string }).text)
    .at(-1);

async function runOf(session: Session, runId: string): Promise<RunStatus> {
  const run = await session.runs.get({ runId });
  if (!run) throw new Error(`no run ${runId}`);
  return run;
}

async function until(session: Session, runId: string, status: RunStatus["status"]): Promise<RunStatus> {
  return vi.waitFor(async () => {
    const run = await runOf(session, runId);
    if (run.status !== status) throw new Error(`run ${runId} is ${run.status}, not ${status}`);
    return run;
  });
}

async function all(session: Session): Promise<Entry[]> {
  const page = await session.read({ limit: 500 });
  if (!page.ok) throw new Error(page.error.message);
  return page.entries;
}

/** What was said, without the settings a harness records along the way. */
const conversation = (entries: Entry[]) =>
  entries.filter((e) => ["user_message", "assistant_message", "tool_result"].includes(e.kind));

/** SPEC v1 §6: each entry names its parent, which a caller can read. */
function expectParentsPublished(entries: Entry[]): void {
  const ids = new Set(entries.map((entry) => entry.id));
  const dangling = entries.filter((entry) => entry.parentEntryId !== undefined && !ids.has(entry.parentEntryId));
  expect(dangling).toEqual([]);
}

const outcomeOf = (run: RunStatus) => (run.status === "done" ? run.outcome : undefined);

export function describeProtocolConformance(name: string, subject: ProtocolSubject): void {
  describe(`SPEC v1 conformance: ${name}`, () => {
    describe("invoke", () => {
      it("answers with a receipt first and ends after its run's run_ended, every event JSON", async () => {
        const agent = await subject.start();
        const events = await drain(agent.invoke({ sessionId: "s", prompt: { text: "hi" } }));
        expect(events[0]?.type).toBe("accepted");
        const runId = accepted(events[0] as InvokeEvent).run.runId;
        const last = events.at(-1);
        expect(last?.type === "entry" && last.entry.kind === "run_ended" && last.entry.runId === runId).toBe(true);
        expect(entriesOf(events).filter((e) => e.kind === "run_ended")).toHaveLength(1);
        expect(answerOf(events)).toBe("answer: hi");
        for (const event of events) expect(JSON.parse(JSON.stringify(event))).toEqual(event);
      });

      it("a rejected invoke is one event and records nothing", async () => {
        const agent = await subject.start();
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "first" } }));
        const before = await all(agent.sessions.get("s"));
        const events = await drain(agent.invoke({ prompt: { text: "x" }, idempotencyKey: "k" }));
        expect(events).toHaveLength(1);
        expect(rejected(events[0] as InvokeEvent).error.code).toBe("invalid_request");
        const dotted = await drain(agent.invoke({ sessionId: "..", prompt: { text: "x" } }));
        expect(rejected(dotted[0] as InvokeEvent).error.code).toBe("invalid_request");
        expect(await all(agent.sessions.get("s"))).toEqual(before);
      });

      it("an invoke without a session gets a new one each time", async () => {
        const agent = await subject.start();
        const a = accepted(await receipt(agent.invoke({ prompt: { text: "a" } })));
        const b = accepted(await receipt(agent.invoke({ prompt: { text: "b" } })));
        expect(a.sessionId).not.toBe(b.sessionId);
      });
    });

    describe("a busy session", () => {
      it("queues runs in arrival order, with their positions", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const first = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, first.run.runId, "running");
        const second = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "two" } })));
        const third = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "three" } })));
        expect(second.run).toMatchObject({ status: "queued", position: 1 });
        expect(third.run).toMatchObject({ status: "queued", position: 2 });
        subject.release();
        await until(session, third.run.runId, "done");
        const started = (await all(session)).filter((e) => e.kind === "run_started").map((e) => e.runId);
        expect(started).toEqual([first.run.runId, second.run.runId, third.run.runId]);
      });

      it("reject answers busy, naming the running run", async () => {
        const agent = await subject.start();
        const first = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(agent.sessions.get("s"), first.run.runId, "running");
        const events = await drain(agent.invoke({ sessionId: "s", prompt: { text: "x" }, whenBusy: "reject" }));
        expect(rejected(events[0] as InvokeEvent).error).toMatchObject({
          code: "busy",
          retryable: true,
          details: { reason: "running", runId: first.run.runId },
        });
        subject.release();
      });

      it("steer joins the running run, which takes the message", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const first = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, first.run.runId, "running");
        // A running run reports the entry each message became as soon as it is written.
        const written = await vi.waitFor(
          async () => {
            const entry = (await all(session)).find((e) => e.kind === "user_message" && e.runId === first.run.runId);
            if (!entry) throw new Error("the run's message is not written yet");
            return entry;
          },
          { timeout: 5000 },
        );
        const steered = agent.invoke({ sessionId: "s", prompt: { text: "also" }, whenBusy: "steer" });
        if (!agent.info().capabilities.steer) {
          expect(rejected((await drain(steered))[0] as InvokeEvent).error.code).toBe("unsupported");
          subject.release();
          return;
        }
        const { first: head, rest } = await opened(steered);
        const joined = accepted(head);
        expect(joined).toMatchObject({ joined: true, duplicate: false });
        expect(joined.run.runId).toBe(first.run.runId);
        expect(joined.run.messages).toHaveLength(2);
        expect(joined.run.messages[0]?.entryId).toBe(written.id);
        subject.release();
        const events = await rest;
        const run = await until(session, first.run.runId, "done");
        expect(run.messages).toHaveLength(2);
        expect(run.messages.every((m) => m.entryId !== undefined)).toBe(true);
        expect(answerOf(events)).toBe("answer: also");
        const users = (await all(session)).filter((e) => e.kind === "user_message" && e.runId === first.run.runId);
        expect(users.map((e) => (e.data as { text: string }).text)).toEqual(["hold", "also"]);
      });

      it("an idle session starts a run whatever whenBusy says", async () => {
        const agent = await subject.start();
        for (const whenBusy of ["queue", "steer", "reject"] as const) {
          const events = await drain(agent.invoke({ sessionId: "s", prompt: { text: whenBusy }, whenBusy }));
          expect(accepted(events[0] as InvokeEvent)).toMatchObject({ joined: false, duplicate: false });
        }
      });

      it("holds 20 queued runs and refuses the 21st with queue_full", async () => {
        const agent = await subject.start();
        const first = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(agent.sessions.get("s"), first.run.runId, "running");
        for (let i = 0; i < 20; i++)
          accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: `q${i}` } })));
        const events = await drain(agent.invoke({ sessionId: "s", prompt: { text: "one too many" } }));
        expect(rejected(events[0] as InvokeEvent).error).toMatchObject({
          code: "busy",
          details: { reason: "queue_full" },
        });
        await agent.sessions.get("s").abort();
        subject.release();
      });

      it("refuses past the process's runs in flight with capacity", async () => {
        const agent = await subject.start({ capacity: 2 });
        accepted(await receipt(agent.invoke({ sessionId: "a", prompt: { text: "hold" } })));
        accepted(await receipt(agent.invoke({ sessionId: "b", prompt: { text: "hold" } })));
        const events = await drain(agent.invoke({ sessionId: "c", prompt: { text: "x" } }));
        expect(rejected(events[0] as InvokeEvent).error).toMatchObject({
          code: "busy",
          details: { reason: "capacity" },
        });
        expect((await agent.sessions.list()).map((s) => s.sessionId)).not.toContain("c");
        subject.release();
      });
    });

    describe("idempotency", () => {
      it("a key seen while queued, running and done returns the same run and records one message", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const holder = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, holder.run.runId, "running");
        const keyed = { sessionId: "s", prompt: { text: "keyed" }, idempotencyKey: "m1" };
        const first = accepted(await receipt(agent.invoke(keyed)));
        const whileQueued = accepted(await receipt(agent.invoke(keyed)));
        expect(whileQueued).toMatchObject({ duplicate: true, run: { runId: first.run.runId, status: "queued" } });
        subject.release();
        await until(session, first.run.runId, "done");
        const whenDone = await drain(agent.invoke(keyed));
        expect(accepted(whenDone[0] as InvokeEvent)).toMatchObject({
          duplicate: true,
          run: { runId: first.run.runId },
        });
        expect(answerOf(whenDone)).toBe("answer: keyed");
        const messages = (await all(session)).filter((e) => e.kind === "user_message" && e.runId === first.run.runId);
        expect(messages).toHaveLength(1);
      });

      it("a duplicate of a running run replays it from its start, so it collects the same answer", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const keyed = { sessionId: "s", prompt: { text: "hold" }, idempotencyKey: "m1" };
        const first = accepted(await receipt(agent.invoke(keyed)));
        await until(session, first.run.runId, "running");
        const { first: head, rest } = await opened(agent.invoke(keyed));
        expect(accepted(head)).toMatchObject({ duplicate: true, run: { status: "running" } });
        subject.release();
        const events = [head, ...(await rest)];
        const kinds = entriesOf(events).map((e) => e.kind);
        expect(kinds[0]).toBe("run_started");
        expect(kinds.at(-1)).toBe("run_ended");
        expect(answerOf(events)).toBe("answer: hold");
      });

      it("concurrent invokes with one key make one run", async () => {
        const agent = await subject.start();
        const keyed = { sessionId: "s", prompt: { text: "once" }, idempotencyKey: "m1" };
        const receipts = await Promise.all([1, 2, 3].map(() => receipt(agent.invoke(keyed))));
        const runIds = new Set(receipts.map((r) => accepted(r).run.runId));
        expect(runIds.size).toBe(1);
        expect(receipts.filter((r) => accepted(r).duplicate)).toHaveLength(2);
      });

      it("an interrupted run's key starts a new run, which the key then names", async () => {
        const agent = await subject.start();
        const keyed = { sessionId: "s", prompt: { text: "hold" }, idempotencyKey: "m1" };
        const first = accepted(await receipt(agent.invoke(keyed)));
        await until(agent.sessions.get("s"), first.run.runId, "running");
        const restarted = await subject.restart();
        const session = restarted.sessions.get("s");
        if (restarted.info().capabilities.durableRuns) return;
        expect(outcomeOf(await runOf(session, first.run.runId))).toEqual({ status: "interrupted" });
        const again = await opened(restarted.invoke(keyed));
        subject.release();
        await again.rest;
        const second = accepted(again.first);
        expect(second.duplicate).toBe(false);
        expect(second.run.runId).not.toBe(first.run.runId);
        expect((await session.runs.get({ idempotencyKey: "m1" }))?.runId).toBe(second.run.runId);
      });
    });

    describe("runs", () => {
      it("a caller that stops reading detaches; the run goes on", async () => {
        const agent = await subject.start();
        const first = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        subject.release();
        const run = await until(agent.sessions.get("s"), first.run.runId, "done");
        expect(run).toMatchObject({ outcome: { status: "completed" }, answer: { text: "answer: hold" } });
      });

      it("runs.follow reattaches after a cursor and ends with the run", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const first = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, first.run.runId, "running");
        const started = (await all(session)).find((e) => e.kind === "run_started" && e.runId === first.run.runId);
        const followed = drain(session.runs.follow(first.run.runId, { after: started?.id as string }));
        subject.release();
        const kinds = entriesOf(await followed).map((e) => e.kind);
        expect(kinds).not.toContain("run_started");
        expect(kinds).toContain("assistant_message");
        expect(kinds.at(-1)).toBe("run_ended");
        expect(rejected((await drain(session.runs.follow("no-such-run")))[0] as FollowEvent).error.code).toBe(
          "not_found",
        );
      });

      it("runs.cancel stops a running run and withdraws a queued one; the rest run", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const running = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, running.run.runId, "running");
        const queued = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "queued" } })));
        const last = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "last" } })));
        expect(await session.runs.cancel(queued.run.runId)).toEqual({ ok: true });
        expect(await session.runs.cancel(running.run.runId)).toEqual({ ok: true });
        const canceled = { status: "canceled", by: "cancel" };
        expect(outcomeOf(await until(session, running.run.runId, "done"))).toEqual(canceled);
        expect(outcomeOf(await runOf(session, queued.run.runId))).toEqual(canceled);
        expect(outcomeOf(await until(session, last.run.runId, "done"))).toEqual({ status: "completed" });
        expect((await session.runs.cancel(last.run.runId)).ok).toBe(false);
      });

      it("abort stops everything and says what; on an idle session it stops nothing", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const running = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, running.run.runId, "running");
        const queued = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "queued" } })));
        expect(await session.abort()).toEqual({
          ok: true,
          stopped: { runId: running.run.runId, queued: [queued.run.runId], compaction: false },
        });
        const aborted = { status: "canceled", by: "abort" };
        expect(outcomeOf(await until(session, running.run.runId, "done"))).toEqual(aborted);
        expect(outcomeOf(await runOf(session, queued.run.runId))).toEqual(aborted);
        expect(await session.abort()).toEqual({ ok: true, stopped: { queued: [], compaction: false } });
      });

      it("the queue goes on after a failed run", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const holder = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, holder.run.runId, "running");
        const failing = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "fail" } })));
        const after = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "after" } })));
        subject.release();
        expect(outcomeOf(await until(session, failing.run.runId, "done"))?.status).toBe("failed");
        expect(outcomeOf(await until(session, after.run.runId, "done"))).toEqual({ status: "completed" });
      });
    });

    describe("restart", () => {
      it("a run accepted before a restart is found after it; one interrupted is closed without an invoke", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const running = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, running.run.runId, "running");
        const queued = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "effect" } })));
        const restarted = await subject.restart();
        const after = restarted.sessions.get("s");
        const { durableRuns, durableQueue } = restarted.info().capabilities;
        const runningAfter = await runOf(after, running.run.runId);
        const queuedAfter = await runOf(after, queued.run.runId);
        if (!durableRuns) expect(outcomeOf(runningAfter)).toEqual({ status: "interrupted" });
        if (!durableQueue) expect(outcomeOf(queuedAfter)).toEqual({ status: "interrupted" });
        if (!durableRuns) {
          const followed = entriesOf(await drain(after.runs.follow(running.run.runId)));
          expect(followed.at(-1)).toMatchObject({ kind: "run_ended", data: { outcome: { status: "interrupted" } } });
          expect(followed.filter((e) => e.kind === "run_ended")).toHaveLength(1);
        }
        if (!durableQueue) expect(subject.effects()).toBe(0);
      });
    });

    describe("reading", () => {
      it("pages after and before a cursor, the newest page without one, and the state alone at limit 0", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        for (const text of ["a", "b", "c"]) await drain(agent.invoke({ sessionId: "s", prompt: { text } }));
        const everything = await all(session);
        const newest = await session.read({ limit: 2 });
        if (!newest.ok) throw new Error(newest.error.message);
        expect(newest.entries).toEqual(everything.slice(-2));
        expect(newest.next).toBeUndefined();
        const older = await session.read({ before: newest.prev as string, limit: 2 });
        if (!older.ok) throw new Error(older.error.message);
        expect(older.entries).toEqual(everything.slice(-4, -2));
        const forward = await session.read({ after: older.entries[0]?.id as string, limit: 2 });
        if (!forward.ok) throw new Error(forward.error.message);
        expect(forward.entries).toEqual(everything.slice(-3, -1));
        const state = await session.read({ limit: 0 });
        expect(state).toMatchObject({ ok: true, entries: [], state: { status: "idle", queued: [] } });
        expect((await session.read({ after: "no-such-entry" })).ok).toBe(false);
        expect((await session.read({ limit: 501 })).ok).toBe(false);
      });

      it("a run's entries carry its id, between its run_started and run_ended", async () => {
        const agent = await subject.start();
        const events = await drain(agent.invoke({ sessionId: "s", prompt: { text: "effect" } }));
        const runId = accepted(events[0] as InvokeEvent).run.runId;
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "again" } }));
        expectParentsPublished(await all(agent.sessions.get("s")));
        const entries = (await all(agent.sessions.get("s"))).filter((e) => e.runId === runId);
        expect(entries[0]?.kind).toBe("run_started");
        expect(entries.at(-1)?.kind).toBe("run_ended");
        expect(entries.map((e) => e.kind)).toEqual(
          expect.arrayContaining(["user_message", "tool_result", "assistant_message"]),
        );
      });

      it("follow catches up, goes live, and a reconnect from the last entry repeats nothing", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "one" } }));
        const seen: Entry[] = [];
        const first = session.follow()[Symbol.asyncIterator]();
        const target = (await all(session)).length;
        while (seen.length < target) {
          const next = await first.next();
          if (!next.done && next.value.type === "entry") seen.push(next.value.entry);
        }
        await first.return?.();
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "two" } }));
        const rest: Entry[] = [];
        const second = session.follow({ after: seen.at(-1)?.id as string })[Symbol.asyncIterator]();
        const total = (await all(session)).length;
        while (seen.length + rest.length < total) {
          const next = await second.next();
          if (!next.done && next.value.type === "entry") rest.push(next.value.entry);
        }
        await second.return?.();
        const ids = [...seen, ...rest].map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual((await all(session)).map((e) => e.id));
      });

      it("an unknown session or cursor is not_found, a single rejected for a follow", async () => {
        const agent = await subject.start();
        const missing = agent.sessions.get("missing");
        const read = await missing.read();
        expect(read.ok ? undefined : read.error.code).toBe("not_found");
        const followed = await drain(missing.follow());
        expect(followed).toHaveLength(1);
        expect(rejected(followed[0] as FollowEvent).error.code).toBe("not_found");
        expect(await missing.runs.get({ runId: "r" })).toBeUndefined();
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "x" } }));
        const badCursor = await drain(agent.sessions.get("s").follow({ after: "no-such-entry" }));
        expect(rejected(badCursor[0] as FollowEvent).error.code).toBe("not_found");
      });

      it("state moves from idle to running and back", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const first = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, first.run.runId, "running");
        const busy = await session.read({ limit: 0 });
        expect(busy).toMatchObject({ ok: true, state: { status: "running", run: { runId: first.run.runId } } });
        subject.release();
        await until(session, first.run.runId, "done");
        expect(await session.read({ limit: 0 })).toMatchObject({ ok: true, state: { status: "idle" } });
      });
    });

    describe("sessions", () => {
      it("create names a session, refuses one that exists, and lists them", async () => {
        const agent = await subject.start();
        expect(await agent.sessions.create({ sessionId: "s" })).toEqual({ ok: true, sessionId: "s" });
        const again = await agent.sessions.create({ sessionId: "s" });
        expect(again.ok ? undefined : again.error.code).toBe("conflict");
        const minted = await agent.sessions.create();
        expect(minted.ok).toBe(true);
        const listed = (await agent.sessions.list()).map((s) => s.sessionId);
        expect(listed).toEqual(expect.arrayContaining(["s", minted.ok ? minted.sessionId : ""]));
      });

      it("a fork holds the history up to its entry and none of the runs, and leaves the source alone", async () => {
        const agent = await subject.start();
        if (!agent.info().capabilities.fork) return;
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "one" } }));
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "two" } }));
        const source = await all(agent.sessions.get("s"));
        const firstAnswer = source.find((e) => e.kind === "assistant_message") as Entry;
        const forked = await agent.sessions.create({
          sessionId: "f",
          fork: { sessionId: "s", entryId: firstAnswer.id },
        });
        expect(forked.ok).toBe(true);
        const copied = await all(agent.sessions.get("f"));
        expect(conversation(copied).map((e) => e.kind)).toEqual(["user_message", "assistant_message"]);
        expect(copied.every((e) => e.runId === undefined)).toBe(true);
        expectParentsPublished(copied);
        expect(await agent.sessions.create({ sessionId: "g", fork: { sessionId: "s" } })).toMatchObject({ ok: true });
        const whole = await all(agent.sessions.get("g"));
        expect(conversation(whole).map((e) => e.kind)).toEqual([
          "user_message",
          "assistant_message",
          "user_message",
          "assistant_message",
        ]);
        expect(whole.slice(1).map((e) => e.parentEntryId)).toEqual(whole.slice(0, -1).map((e) => e.id));
        expect(await all(agent.sessions.get("s"))).toEqual(source);
        expect((await agent.sessions.get("f").runs.get({ runId: source[0]?.runId as string })) ?? null).toBeNull();
      });

      it("rewind moves the active branch and keeps the earlier one; a running session is busy", async () => {
        const agent = await subject.start();
        if (!agent.info().capabilities.rewind) return;
        const session = agent.sessions.get("s");
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "one" } }));
        const point = (await all(session)).find((e) => e.kind === "assistant_message") as Entry;
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "two" } }));
        const before = await all(session);
        expect(await session.rewind(point.id)).toEqual({ ok: true });
        expect(await session.read({ limit: 0 })).toMatchObject({ state: { leafEntryId: point.id } });
        expect((await all(session)).slice(0, before.length)).toEqual(before);
        const holder = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, holder.run.runId, "running");
        const busy = await session.rewind(point.id);
        expect(busy.ok ? undefined : busy.error.code).toBe("busy");
        subject.release();
      });

      it("compact on an empty history has nothing to compact", async () => {
        const agent = await subject.start();
        if (!agent.info().capabilities.compaction) return;
        await agent.sessions.create({ sessionId: "s" });
        const result = await agent.sessions.get("s").compact();
        expect(result.ok ? undefined : result.error.code).toBe("nothing_to_compact");
      });

      it("update sets what is updatable; delete cancels the runs and removes the session", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "x" } }));
        if (agent.info().capabilities.updatable.includes("name")) {
          expect(await session.update({ name: "named" })).toEqual({ ok: true });
          expect(await session.read({ limit: 0 })).toMatchObject({ state: { name: "named" } });
        }
        if (!agent.info().capabilities.delete) return;
        const holder = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, holder.run.runId, "running");
        const followed = await opened(session.runs.follow(holder.run.runId));
        expect(followed.first).toMatchObject({ type: "entry", entry: { kind: "run_started" } });
        expect(await session.delete()).toEqual({ ok: true });
        const ended = entriesOf(await followed.rest).at(-1);
        expect(ended).toMatchObject({ kind: "run_ended", data: { outcome: { status: "canceled", by: "delete" } } });
        const read = await session.read();
        expect(read.ok ? undefined : read.error.code).toBe("not_found");
        expect((await agent.sessions.list()).map((s) => s.sessionId)).not.toContain("s");
      });
    });
  });
}
