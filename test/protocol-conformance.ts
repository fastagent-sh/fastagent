/**
 * SPEC v1 conformance (docs/SPEC.md §8), runnable against any `Agent`. Everything harness-specific comes from the
 * subject; what a piece of work does is chosen by its message (`hold`, `fail`, `effect`, `late`, or any other text,
 * answered `answer: <text>`), which a subject maps onto its harness.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent, DoneMessage, Entry, FollowEvent, InvokeEvent, MessageStatus, Session } from "../src/protocol.ts";

export interface ProtocolSubject {
  /** A fresh agent over fresh storage. `capacity` lowers the messages a process holds in flight. */
  start(options?: { capacity?: number }): Agent | Promise<Agent>;
  /** The same storage, opened by a new process; the previous agent is abandoned mid-work. */
  restart(): Agent | Promise<Agent>;
  /** Lets every `hold` and `late` work of the current process go on. */
  release(): void;
  /** How many times an `effect` work's tool has run. */
  effects(): number;
  /**
   * Whether the subject maps `late`: answered at once, its work settling only on `release()`, so a steer sent in
   * between arrives after the answer. A subject without it proves that rule in a test of its own.
   */
  late?: true;
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

const doneOf = (events: (InvokeEvent | FollowEvent)[]): DoneMessage[] =>
  events.flatMap((event) => (event.type === "done" ? [event.message] : []));

const answerOf = (events: InvokeEvent[]): string | undefined => doneOf(events).at(-1)?.answer?.text;

const idOf = (event: InvokeEvent): string => accepted(event).message.messageId;

async function messageOf(session: Session, messageId: string): Promise<MessageStatus> {
  const message = await session.messages.get({ messageId });
  if (!message) throw new Error(`no message ${messageId}`);
  return message;
}

async function until(session: Session, messageId: string, status: MessageStatus["status"]): Promise<MessageStatus> {
  return vi.waitFor(
    async () => {
      const message = await messageOf(session, messageId);
      if (message.status !== status) throw new Error(`message ${messageId} is ${message.status}, not ${status}`);
      return message;
    },
    { timeout: 5000 },
  );
}

async function all(session: Session): Promise<Entry[]> {
  const page = await session.read({ limit: 500 });
  if (!page.ok) throw new Error(page.error.message);
  return page.entries;
}

/** The message each `user_message` entry names, in history order. */
const takenOrder = (entries: Entry[]): unknown[] =>
  entries.filter((e) => e.kind === "user_message").map((e) => (e.data as { messageId?: unknown }).messageId);

/** What was said, without the settings a harness records along the way. */
const conversation = (entries: Entry[]) =>
  entries.filter((e) => ["user_message", "assistant_message", "tool_result"].includes(e.kind));

/** SPEC v1 §6: each entry names its parent, which a caller can read. */
function expectParentsPublished(entries: Entry[]): void {
  const ids = new Set(entries.map((entry) => entry.id));
  const dangling = entries.filter((entry) => entry.parentEntryId !== undefined && !ids.has(entry.parentEntryId));
  expect(dangling).toEqual([]);
}

const outcomeOf = (message: MessageStatus) => (message.status === "done" ? message.outcome : undefined);

export function describeProtocolConformance(name: string, subject: ProtocolSubject): void {
  describe(`SPEC v1 conformance: ${name}`, () => {
    describe("invoke", () => {
      it("answers with a receipt first and ends with its message's done, every event JSON", async () => {
        const agent = await subject.start();
        const events = await drain(agent.invoke({ sessionId: "s", prompt: { text: "hi" } }));
        expect(events[0]?.type).toBe("accepted");
        const messageId = idOf(events[0] as InvokeEvent);
        const last = events.at(-1);
        expect(last?.type === "done" && last.message.messageId === messageId).toBe(true);
        expect(doneOf(events)).toHaveLength(1);
        expect(answerOf(events)).toBe("answer: hi");
        expect(entriesOf(events)[0]).toMatchObject({ kind: "user_message", data: { messageId } });
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
      it("queues messages in arrival order, with their positions", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const first = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, first, "taken");
        const second = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "two" } })));
        const third = accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "three" } })));
        expect(second.message).toMatchObject({ status: "queued", position: 0 });
        expect(third.message).toMatchObject({ status: "queued", position: 1 });
        subject.release();
        await until(session, third.message.messageId, "done");
        expect(takenOrder(await all(session))).toEqual([first, second.message.messageId, third.message.messageId]);
      });

      it("reject answers busy", async () => {
        const agent = await subject.start();
        const first = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(agent.sessions.get("s"), first, "taken");
        const events = await drain(agent.invoke({ sessionId: "s", prompt: { text: "x" }, whenBusy: "reject" }));
        expect(rejected(events[0] as InvokeEvent).error).toMatchObject({
          code: "busy",
          retryable: true,
          details: { reason: "running" },
        });
        subject.release();
      });

      it("a steer waits at the front of the queue, is taken by the work in progress, and shares its answer", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const first = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        // A taken message reports its entry as soon as it is written.
        const taken = await until(session, first, "taken");
        const queued = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "queued" } })));
        const steered = agent.invoke({ sessionId: "s", prompt: { text: "also" }, whenBusy: "steer" });
        if (!agent.info().capabilities.steer) {
          expect(rejected((await drain(steered))[0] as InvokeEvent).error.code).toBe("unsupported");
          subject.release();
          return;
        }
        const { first: head, rest } = await opened(steered);
        const steer = accepted(head);
        expect(steer).toMatchObject({ duplicate: false, message: { status: "queued", position: 0 } });
        expect(await messageOf(session, queued)).toMatchObject({ status: "queued", position: 1 });
        subject.release();
        const events = await rest;
        const done = await until(session, first, "done");
        const shared = await until(session, steer.message.messageId, "done");
        expect(answerOf(events)).toBe("answer: also");
        expect(shared.status === "done" && shared.answer).toEqual(done.status === "done" && done.answer);
        expect(shared.status === "done" && shared.entryId).toBeTruthy();
        expect(done.status === "done" && done.entryId).toBe(taken.status === "taken" && taken.entryId);
        if (agent.info().capabilities.usage) {
          expect(done.status === "done" && done.usage).toBeTruthy();
          expect(shared.status === "done" && shared.usage).toBeUndefined();
        }
        const users = (await all(session)).filter((e) => e.kind === "user_message");
        expect(users.map((e) => (e.data as { text: string }).text).slice(0, 2)).toEqual(["hold", "also"]);
        await until(session, queued, "done");
      });

      it("a steer the work has not taken when it ends is taken by the next work, before the queue", async () => {
        const agent = await subject.start();
        if (!subject.late || !agent.info().capabilities.steer) return;
        const session = agent.sessions.get("s");
        const first = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "late" } })));
        await vi.waitFor(async () => expect((await messageOf(session, first)).status).toBe("taken"));
        await vi.waitFor(async () =>
          expect(conversation(await all(session)).map((e) => e.kind)).toContain("assistant_message"),
        );
        const queued = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "queued" } })));
        const steer = idOf(
          await receipt(agent.invoke({ sessionId: "s", prompt: { text: "also" }, whenBusy: "steer" })),
        );
        subject.release();
        const answered = await until(session, steer, "done");
        expect(answered).toMatchObject({ outcome: { status: "completed" }, answer: { text: "answer: also" } });
        expect(await until(session, first, "done")).toMatchObject({ answer: { text: "answer: late" } });
        await until(session, queued, "done");
        expect(takenOrder(await all(session))).toEqual([first, steer, queued]);
      });

      it("an idle session takes a message whatever whenBusy says", async () => {
        const agent = await subject.start();
        for (const whenBusy of ["queue", "steer", "reject"] as const) {
          const events = await drain(agent.invoke({ sessionId: "s", prompt: { text: whenBusy }, whenBusy }));
          expect(accepted(events[0] as InvokeEvent)).toMatchObject({ duplicate: false });
          expect(answerOf(events)).toBe(`answer: ${whenBusy}`);
        }
      });

      it("holds 20 queued messages, steered ones included, and refuses the 21st with queue_full", async () => {
        const agent = await subject.start();
        const first = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(agent.sessions.get("s"), first, "taken");
        const steer = agent.info().capabilities.steer;
        for (let i = 0; i < 20; i++) {
          const whenBusy = steer && i === 0 ? "steer" : "queue";
          accepted(await receipt(agent.invoke({ sessionId: "s", prompt: { text: `q${i}` }, whenBusy })));
        }
        const events = await drain(agent.invoke({ sessionId: "s", prompt: { text: "one too many" } }));
        expect(rejected(events[0] as InvokeEvent).error).toMatchObject({
          code: "busy",
          details: { reason: "queue_full" },
        });
        await agent.sessions.get("s").abort();
        subject.release();
      });

      it("refuses past the process's messages in flight with capacity", async () => {
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
      it("a key seen while queued, taken and done returns the same message and records one entry", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const holder = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, holder, "taken");
        const keyed = { sessionId: "s", prompt: { text: "keyed" }, idempotencyKey: "m1" };
        const first = idOf(await receipt(agent.invoke(keyed)));
        const whileQueued = accepted(await receipt(agent.invoke(keyed)));
        expect(whileQueued).toMatchObject({ duplicate: true, message: { messageId: first, status: "queued" } });
        subject.release();
        await until(session, first, "done");
        const whenDone = await drain(agent.invoke(keyed));
        expect(accepted(whenDone[0] as InvokeEvent)).toMatchObject({ duplicate: true, message: { messageId: first } });
        expect(answerOf(whenDone)).toBe("answer: keyed");
        expect(takenOrder(await all(session)).filter((id) => id === first)).toHaveLength(1);
      });

      it("a duplicate of a taken message replays it from its own entry, so it collects the same answer", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const keyed = { sessionId: "s", prompt: { text: "hold" }, idempotencyKey: "m1" };
        const first = idOf(await receipt(agent.invoke(keyed)));
        await until(session, first, "taken");
        const { first: head, rest } = await opened(agent.invoke(keyed));
        expect(accepted(head)).toMatchObject({ duplicate: true, message: { status: "taken" } });
        subject.release();
        const events = [head, ...(await rest)];
        expect(entriesOf(events)[0]).toMatchObject({ kind: "user_message", data: { messageId: first } });
        expect(events.at(-1)?.type).toBe("done");
        expect(answerOf(events)).toBe("answer: hold");
      });

      it("a duplicate of a done message replays what its work wrote, and nothing after it", async () => {
        const agent = await subject.start();
        const keyed = { sessionId: "s", prompt: { text: "effect" }, idempotencyKey: "m1" };
        const live = entriesOf(await drain(agent.invoke(keyed)));
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "after" } }));
        const replayed = entriesOf(await drain(agent.invoke(keyed)));
        expect(replayed.map((e) => e.id)).toEqual(live.map((e) => e.id));
        expect(replayed.map((e) => e.kind)).toContain("tool_result");
      });

      it("concurrent invokes with one key make one message", async () => {
        const agent = await subject.start();
        const keyed = { sessionId: "s", prompt: { text: "once" }, idempotencyKey: "m1" };
        const receipts = await Promise.all([1, 2, 3].map(() => receipt(agent.invoke(keyed))));
        const ids = new Set(receipts.map((r) => idOf(r)));
        expect(ids.size).toBe(1);
        expect(receipts.filter((r) => accepted(r).duplicate)).toHaveLength(2);
      });

      it("an interrupted message's key accepts it again, and the key then names the new one", async () => {
        const agent = await subject.start();
        const keyed = { sessionId: "s", prompt: { text: "hold" }, idempotencyKey: "m1" };
        const first = idOf(await receipt(agent.invoke(keyed)));
        await until(agent.sessions.get("s"), first, "taken");
        const restarted = await subject.restart();
        const session = restarted.sessions.get("s");
        if (restarted.info().capabilities.durableWork) return;
        expect(outcomeOf(await messageOf(session, first))).toEqual({ status: "interrupted" });
        const again = await opened(restarted.invoke(keyed));
        subject.release();
        await again.rest;
        const second = accepted(again.first);
        expect(second.duplicate).toBe(false);
        expect(second.message.messageId).not.toBe(first);
        expect((await session.messages.get({ idempotencyKey: "m1" }))?.messageId).toBe(second.message.messageId);
      });
    });

    describe("messages", () => {
      it("a caller that stops reading detaches; the work goes on", async () => {
        const agent = await subject.start();
        const first = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        subject.release();
        const message = await until(agent.sessions.get("s"), first, "done");
        expect(message).toMatchObject({ outcome: { status: "completed" }, answer: { text: "answer: hold" } });
      });

      it("messages.follow reattaches after a cursor and ends with the message's done", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const first = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        const taken = await until(session, first, "taken");
        const own = taken.status === "taken" ? taken.entryId : "";
        const followed = drain(session.messages.follow(first, { after: own }));
        subject.release();
        const events = await followed;
        const kinds = entriesOf(events).map((e) => e.kind);
        expect(kinds).not.toContain("user_message");
        expect(kinds).toContain("assistant_message");
        expect(events.at(-1)).toMatchObject({ type: "done", message: { messageId: first } });
        expect(rejected((await drain(session.messages.follow("no-such-message")))[0] as FollowEvent).error.code).toBe(
          "not_found",
        );
      });

      it("messages.cancel stops work in progress and withdraws a queued message; the rest are taken", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const taken = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, taken, "taken");
        const queued = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "queued" } })));
        const last = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "last" } })));
        expect(await session.messages.cancel(queued)).toEqual({ ok: true });
        expect(await session.messages.cancel(taken)).toEqual({ ok: true });
        const canceled = { status: "canceled", by: "cancel" };
        expect(outcomeOf(await until(session, taken, "done"))).toEqual(canceled);
        const withdrawn = await messageOf(session, queued);
        expect(outcomeOf(withdrawn)).toEqual(canceled);
        expect(withdrawn.status === "done" && withdrawn.entryId).toBeUndefined();
        expect(outcomeOf(await until(session, last, "done"))).toEqual({ status: "completed" });
        expect((await session.messages.cancel(last)).ok).toBe(false);
      });

      it("a steer still waiting when the work is canceled is taken by the next work", async () => {
        const agent = await subject.start();
        if (!subject.late || !agent.info().capabilities.steer) return;
        const session = agent.sessions.get("s");
        const first = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "late" } })));
        await vi.waitFor(async () =>
          expect(conversation(await all(session)).map((e) => e.kind)).toContain("assistant_message"),
        );
        const steer = idOf(
          await receipt(agent.invoke({ sessionId: "s", prompt: { text: "also" }, whenBusy: "steer" })),
        );
        expect(await session.messages.cancel(first)).toEqual({ ok: true });
        expect(outcomeOf(await until(session, first, "done"))).toEqual({ status: "canceled", by: "cancel" });
        expect(await until(session, steer, "done")).toMatchObject({ answer: { text: "answer: also" } });
      });

      it("abort stops everything and says what; on an idle session it stops nothing", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const taken = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, taken, "taken");
        const queued = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "queued" } })));
        expect(await session.abort()).toEqual({
          ok: true,
          stopped: { taken: [taken], queued: [queued], compaction: false },
        });
        const aborted = { status: "canceled", by: "abort" };
        expect(outcomeOf(await until(session, taken, "done"))).toEqual(aborted);
        expect(outcomeOf(await messageOf(session, queued))).toEqual(aborted);
        expect(await session.abort()).toEqual({ ok: true, stopped: { taken: [], queued: [], compaction: false } });
      });

      it("the queue goes on after work that failed", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const holder = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, holder, "taken");
        const failing = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "fail" } })));
        const after = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "after" } })));
        subject.release();
        expect(outcomeOf(await until(session, failing, "done"))?.status).toBe("failed");
        expect(outcomeOf(await until(session, after, "done"))).toEqual({ status: "completed" });
      });
    });

    describe("restart", () => {
      it("a message accepted before a restart is found after it; one interrupted ends without an invoke", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const taken = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, taken, "taken");
        const queued = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "effect" } })));
        const before = await all(session);
        const restarted = await subject.restart();
        const after = restarted.sessions.get("s");
        const { durableWork, durableQueue } = restarted.info().capabilities;
        const takenAfter = await messageOf(after, taken);
        const queuedAfter = await messageOf(after, queued);
        if (!durableWork) {
          expect(outcomeOf(takenAfter)).toEqual({ status: "interrupted" });
          // What its work wrote stays named, and a reattaching follow replays it before its end.
          const followed = await drain(after.messages.follow(taken));
          expect(entriesOf(followed).map((e) => e.id)).toEqual(
            before
              .slice(before.findIndex((e) => (e.data as { messageId?: unknown }).messageId === taken))
              .map((e) => e.id),
          );
          expect(doneOf(followed)).toEqual([expect.objectContaining({ outcome: { status: "interrupted" } })]);
        }
        if (!durableQueue) expect(outcomeOf(queuedAfter)).toEqual({ status: "interrupted" });
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
        expect(state).toMatchObject({ ok: true, entries: [], state: { status: "idle", taken: [], queued: [] } });
        expect((await session.read({ after: "no-such-entry" })).ok).toBe(false);
        expect((await session.read({ limit: 501 })).ok).toBe(false);
      });

      it("the history is the conversation; each user_message names its message", async () => {
        const agent = await subject.start();
        const first = await drain(agent.invoke({ sessionId: "s", prompt: { text: "effect" } }));
        const second = await drain(agent.invoke({ sessionId: "s", prompt: { text: "again" } }));
        const entries = await all(agent.sessions.get("s"));
        expectParentsPublished(entries);
        expect(takenOrder(entries)).toEqual([idOf(first[0] as InvokeEvent), idOf(second[0] as InvokeEvent)]);
        expect(entries.map((e) => e.kind)).toEqual(
          expect.arrayContaining(["user_message", "tool_result", "assistant_message"]),
        );
        expect(entries.map((e) => e.kind).filter((kind) => kind.startsWith("message_"))).toEqual([]);
        const done = doneOf(first)[0];
        expect(done?.lastEntryId).toBe(done?.answer?.entryId);
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
        expect(await missing.messages.get({ messageId: "m" })).toBeUndefined();
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "x" } }));
        const badCursor = await drain(agent.sessions.get("s").follow({ after: "no-such-entry" }));
        expect(rejected(badCursor[0] as FollowEvent).error.code).toBe("not_found");
      });

      it("state moves from idle to running and back", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        const first = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, first, "taken");
        const busy = await session.read({ limit: 0 });
        expect(busy).toMatchObject({ ok: true, state: { status: "running", taken: [{ messageId: first }] } });
        subject.release();
        await until(session, first, "done");
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

      it("a fork holds the history up to its entry and none of the messages, and leaves the source alone", async () => {
        const agent = await subject.start();
        if (!agent.info().capabilities.fork) return;
        const one = await drain(agent.invoke({ sessionId: "s", prompt: { text: "one" } }));
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
        expect(takenOrder(copied)).toEqual([undefined]);
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
        const copiedMessage = await agent.sessions.get("f").messages.get({ messageId: idOf(one[0] as InvokeEvent) });
        expect(copiedMessage ?? null).toBeNull();
      });

      it("rewind moves the active branch and keeps the earlier one; a working session is busy", async () => {
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
        const holder = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, holder, "taken");
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

      it("update sets what is updatable; delete ends the messages and removes the session", async () => {
        const agent = await subject.start();
        const session = agent.sessions.get("s");
        await drain(agent.invoke({ sessionId: "s", prompt: { text: "x" } }));
        if (agent.info().capabilities.updatable.includes("name")) {
          expect(await session.update({ name: "named" })).toEqual({ ok: true });
          expect(await session.read({ limit: 0 })).toMatchObject({ state: { name: "named" } });
        }
        if (!agent.info().capabilities.delete) return;
        const holder = idOf(await receipt(agent.invoke({ sessionId: "s", prompt: { text: "hold" } })));
        await until(session, holder, "taken");
        const followed = await opened(session.messages.follow(holder));
        expect(followed.first).toMatchObject({ type: "entry", entry: { kind: "user_message" } });
        expect(await session.delete()).toEqual({ ok: true });
        expect((await followed.rest).at(-1)).toMatchObject({
          type: "done",
          message: { outcome: { status: "canceled", by: "delete" } },
        });
        const read = await session.read();
        expect(read.ok ? undefined : read.error.code).toBe("not_found");
        expect((await agent.sessions.list()).map((s) => s.sessionId)).not.toContain("s");
      });
    });
  });
}
