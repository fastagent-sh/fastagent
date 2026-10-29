/**
 * The Agent API's conformance suite (docs/design/agent-api.md §11), runnable against any `Agent`. What a message makes
 * the agent do is chosen by its text, which a subject maps onto its harness:
 *
 * - `hold`: a tool call that waits for `release()` and stops when aborted; `stubborn`: one that waits whatever its
 *   abort signal says; `effect`: one whose runs `effects()` counts; `mark`: one that has its counted effect and then
 *   holds; `finish`: one that ends the run without an answer; `stream`: one whose output's lines are `one`, `two`
 *   and `three of the lines`, written over time; `nested`: one that calls `lookup` with
 *   `{ city: "London" }` from inside it. After a tool call, the answer is `answer: <tool>`.
 * - `fail`: the model call fails; `flaky`: it fails once in a way worth retrying, then answers; `long`: the answer is
 *   cut off at its token limit; `slow`: the answer streams slowly; `ponder`: it streams its thinking slowly, then
 *   answers; `instructions`: the answer is `instructions: ` and the system prompt the model saw.
 * - Anything else is answered `answer: <text the model saw>`. `info().commands` offers `greet`, which a model sees as
 *   `hello <args>`. `info().tools` lists the tools above.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Agent,
  type ContentPart,
  type Entry,
  type Message,
  type MessageStreamEvent,
  type SendRequest,
  type SessionEvent,
  hasEnded,
} from "../src/agent-api.ts";

export interface AgentApiSubject {
  /**
   * A fresh agent over fresh storage. `inFlightPerProcess` lowers the messages the process holds; `signedOut` leaves
   * its model provider without a credential.
   */
  start(options?: { inFlightPerProcess?: number; signedOut?: boolean }): Promise<Agent>;
  /** The same storage, opened by a new process after the previous one stopped; `removeTools`: a deployment without them. */
  restart(options?: { removeTools?: string[] }): Promise<Agent>;
  /** Lets every `hold` and `stubborn` call of the current process go on. */
  release(): void;
  /** How many `hold` and `stubborn` calls are running now. */
  held(): number;
  /** How many `hold` and `stubborn` calls were told to stop: a cancel's stop is recorded before it signals them. */
  signalled(): number;
  effects(): number;
  /** The storage fails every call from now on. */
  failStorage(): void;
  /** Whether a send without a key is given one: `connectAgent` keys its own, so that a lost answer can be found. */
  keysSends?: boolean;
  stop(): Promise<void>;
}

const WAIT = 30;
const text = (value: string): ContentPart[] => [{ type: "text", text: value }];

async function newSession(agent: Agent): Promise<string> {
  return (await agent.sessions.create()).id;
}

const byId = (message: Message) => ({ sessionId: message.sessionId, messageId: message.id });

/** The message once it has ended. */
async function ended(agent: Agent, message: Message): Promise<Message> {
  const now = await agent.messages.get(byId(message), { wait: WAIT });
  if (!hasEnded(now)) throw new Error(`the message has not ended after ${WAIT}s: ${JSON.stringify(now)}`);
  return now;
}

async function untilStatus(agent: Agent, message: Message, status: Message["status"]) {
  await vi.waitFor(async () => expect((await agent.messages.get(byId(message))).status).toBe(status), {
    timeout: 5000,
    interval: 10,
  });
}

async function history(agent: Agent, sessionId: string): Promise<Entry[]> {
  const newest = await agent.sessions.entries(sessionId, { limit: 500 });
  const all = [...newest.data];
  for (let before = newest.prev; before !== undefined; ) {
    const older = await agent.sessions.entries(sessionId, { before, limit: 500 });
    all.unshift(...older.data);
    before = older.prev;
  }
  return all;
}

/** A session's events being read: they arrive in order, and `close()` detaches. */
function attach(agent: Agent, sessionId: string, options?: { after?: string; signal?: AbortSignal }) {
  const iterator = agent.sessions.events(sessionId, options)[Symbol.asyncIterator]();
  return {
    async until(stop: (event: SessionEvent) => boolean): Promise<SessionEvent[]> {
      const out: SessionEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error(`the stream ended before the event awaited; read ${JSON.stringify(out)}`);
        out.push(next.value);
        if (stop(next.value)) return out;
      }
    },
    async rest(): Promise<SessionEvent[]> {
      const out: SessionEvent[] = [];
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) out.push(next.value);
      return out;
    },
    next: () => iterator.next(),
    close: async () => {
      await iterator.return?.();
    },
  };
}

const isState = (event: SessionEvent) => event.type === "state";
const doneOf = (message: Message) => (event: SessionEvent) => event.type === "done" && event.message.id === message.id;
const entriesIn = (events: readonly MessageStreamEvent[]): Entry[] =>
  events.flatMap((event) => (event.type === "entry" ? [event.entry] : []));
const messageOf = (entry: Entry): string | undefined =>
  entry.kind === "user" ? ((entry.data as { messageId?: string }).messageId ?? undefined) : undefined;

export function agentApiConformance(name: string, subject: AgentApiSubject): void {
  describe(`Agent API conformance: ${name}`, () => {
    let agent: Agent;
    /** Until the message just sent is running its `hold` or `stubborn` call, so a release or a stop reaches it. */
    const holding = () => vi.waitFor(() => expect(subject.held()).toBe(1), { timeout: 5000, interval: 5 });
    /** Until the cancel just sent has signalled the tool it stops. */
    const stopRecorded = (count = 1) =>
      vi.waitFor(() => expect(subject.signalled()).toBe(count), { timeout: 5000, interval: 5 });
    const send = (request: SendRequest, options?: Parameters<Agent["messages"]["send"]>[1]) =>
      agent.messages.send(request, options);
    beforeEach(async () => {
      agent = await subject.start();
    });
    afterEach(async () => {
      await subject.stop();
    });

    describe("Sending", () => {
      it("resolves once the message is recorded, without waiting for it to be answered", async () => {
        const sessionId = await newSession(agent);
        const message = await send({ sessionId, content: "hold" });
        expect(message).toMatchObject({ sessionId, status: expect.stringMatching(/^(queued|running)$/) });
        expect(await agent.messages.get(byId(message))).toMatchObject({ id: message.id });
        let settled = false;
        const waiting = ended(agent, message).then((end) => {
          settled = true;
          return end;
        });
        await holding();
        expect(settled).toBe(false);
        subject.release();
        expect(await waiting).toMatchObject({ status: "completed", answer: { text: "answer: hold" } });
      });

      it("records nothing for a rejection", async () => {
        const sessionId = await newSession(agent);
        for (const request of [
          { sessionId, content: [] },
          { sessionId, content: [{ type: "video" }] },
          { sessionId, content: [{ type: "image", mimeType: "image/png", ref: "x:1" }] },
          { sessionId, content: "keyed", idempotencyKey: "" },
          { sessionId, content: "keyed", idempotencyKey: "k".repeat(257) },
          { sessionId, content: "hi", whenBusy: "later" },
          { content: "no session" },
        ]) {
          await expect(send(request as SendRequest)).rejects.toMatchObject({
            code: "invalid_request",
            retryable: false,
          });
        }
        expect((await agent.sessions.entries(sessionId)).data).toEqual([]);
        expect(await agent.sessions.get(sessionId)).toMatchObject({ status: "idle" });
      });

      it("reads a field given as undefined as one left out, as a TypeScript Caller writes it", async () => {
        const unset = undefined as string | undefined;
        const sessionId = (await agent.sessions.create({ model: undefined, forkFrom: undefined })).id;
        const message = await send(
          { sessionId, content: "hi", idempotencyKey: unset, whenBusy: undefined },
          { wait: WAIT, signal: undefined },
        );
        expect(message).toMatchObject({ status: "completed", answer: { text: "answer: hi" } });
        if (subject.keysSends) expect(message.idempotencyKey).toEqual(expect.any(String));
        else expect(message).not.toHaveProperty("idempotencyKey");
        expect(
          (await agent.sessions.entries(sessionId, { before: unset, after: unset, limit: undefined })).data,
        ).toHaveLength(2);
        expect((await agent.sessions.list({ after: unset })).data.map(({ id }) => id)).toContain(sessionId);
        expect(await agent.sessions.update(sessionId, { thinkingLevel: "high", model: undefined })).toMatchObject({
          thinkingLevel: "high",
        });
        await expect(agent.sessions.update(sessionId, { model: undefined })).rejects.toMatchObject({
          code: "invalid_request",
        });
        await agent.sessions.compact(sessionId, { instructions: unset });
      });

      it("takes a string as one text part, and text and images", async () => {
        const sessionId = await newSession(agent);
        expect((await ended(agent, await send({ sessionId, content: "hi" }))).answer?.text).toBe("answer: hi");
        const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } as const;
        await ended(agent, await send({ sessionId, content: [{ type: "text", text: "look" }, image] }));
        const users = (await history(agent, sessionId)).filter((entry) => entry.kind === "user");
        expect((users[0] as Entry).data).toMatchObject({ content: text("hi") });
      });

      it("refuses an unknown session, and a message id as a session's, with not_found", async () => {
        await expect(send({ sessionId: "no-such-session", content: "hi" })).rejects.toMatchObject({
          code: "not_found",
        });
        const message = await send({ sessionId: await newSession(agent), content: "hi" });
        await expect(send({ sessionId: message.id, content: "hi" })).rejects.toMatchObject({ code: "not_found" });
      });

      it("expands a command for the model while its user entry holds the text as sent", async () => {
        expect((await agent.info()).commands).toContainEqual({ name: "greet", description: "Greets someone" });
        const sessionId = await newSession(agent);
        const command = await send({ sessionId, content: "/greet Bob" });
        expect((await ended(agent, command)).answer?.text).toBe("answer: hello Bob");
        const unknown = await send({ sessionId, content: "/nope x" });
        expect((await ended(agent, unknown)).answer?.text).toBe("answer: /nope x");
        const users = (await history(agent, sessionId)).filter((entry) => entry.kind === "user");
        expect(users.map((entry) => (entry.data as { content: ContentPart[] }).content)).toEqual([
          text("/greet Bob"),
          text("/nope x"),
        ]);
      });

      it("waits for the end with `wait`, or answers the status as it is once the wait is over", async () => {
        const sessionId = await newSession(agent);
        const answered = await send({ sessionId, content: "hi" }, { wait: WAIT });
        expect(answered).toMatchObject({ status: "completed", answer: { text: "answer: hi" } });
        const started = Date.now();
        const running = await send({ sessionId, content: "hold" }, { wait: 0.2 });
        expect(Date.now() - started).toBeGreaterThanOrEqual(150);
        expect(running.status).toBe("running");
        expect(await agent.messages.get(byId(running), { wait: 0.1 })).toMatchObject({ status: "running" });
        subject.release();
        expect(await agent.messages.get(byId(running), { wait: WAIT })).toMatchObject({ status: "completed" });
        expect(await agent.messages.get(byId(answered), { wait: WAIT })).toEqual(answered);
        await expect(send({ sessionId, content: "hi" }, { wait: -1 })).rejects.toMatchObject({
          code: "invalid_request",
        });
      });

      it("lets go of a wait on its signal, rejecting with its reason, and the message goes on", async () => {
        const sessionId = await newSession(agent);
        const controller = new AbortController();
        const reason = new Error("the Caller left");
        const sending = send({ sessionId, content: "hold" }, { wait: WAIT, signal: controller.signal });
        await holding();
        controller.abort(reason);
        await expect(sending).rejects.toBe(reason);
        const [message] = (await history(agent, sessionId)).flatMap((entry) => messageOf(entry) ?? []);
        const running = await agent.messages.get({ sessionId, messageId: message as string });
        expect(running.status).toBe("running");
        const getting = agent.messages.get(byId(running), { wait: WAIT, signal: AbortSignal.abort(reason) });
        await expect(getting).rejects.toBe(reason);
        subject.release();
        expect((await ended(agent, running)).status).toBe("completed");
        await expect(send({ sessionId, content: "never sent" }, { signal: AbortSignal.abort(reason) })).rejects.toBe(
          reason,
        );
        expect((await history(agent, sessionId)).filter((entry) => entry.kind === "user")).toHaveLength(1);
      });

      it("rejects a send whose storage fails once it is recorded unconfirmed, with its messageId", async () => {
        const sessionId = await newSession(agent);
        const sending = send({ sessionId, content: "hold" }, { wait: WAIT });
        await holding();
        subject.failStorage();
        subject.release();
        const error = await sending.then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
        expect(error).toMatchObject({
          code: "unconfirmed",
          retryable: false,
          details: { sessionId, messageId: expect.any(String) },
        });
        // The key that finds it, when the binding gave the send one of its own.
        if (subject.keysSends) expect(error).toMatchObject({ details: { idempotencyKey: expect.any(String) } });
      });

      it("gives results and events that are JSON", async () => {
        const sessionId = await newSession(agent);
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        const message = await send({ sessionId, content: "hi" });
        expect(JSON.parse(JSON.stringify(message))).toEqual(message);
        const events = await watching.until(doneOf(message));
        await watching.close();
        expect(JSON.parse(JSON.stringify(events))).toEqual(events);
        const page = await agent.sessions.entries(sessionId);
        expect(JSON.parse(JSON.stringify(page))).toEqual(page);
        const session = await agent.sessions.get(sessionId);
        expect(JSON.parse(JSON.stringify(session))).toEqual(session);
      });
    });

    describe("Busy", () => {
      it("takes queued messages in arrival order", async () => {
        const sessionId = await newSession(agent);
        const first = await send({ sessionId, content: "hold" });
        await holding();
        const queued: Message[] = [];
        for (const word of ["a", "b", "c"]) queued.push(await send({ sessionId, content: word }));
        expect(queued.map((message) => message.status)).toEqual(["queued", "queued", "queued"]);
        subject.release();
        for (const message of queued) expect((await ended(agent, message)).status).toBe("completed");
        const order = (await history(agent, sessionId)).flatMap((entry) => messageOf(entry) ?? []);
        expect(order).toEqual([first, ...queued].map((message) => message.id));
      });

      it("rejects a reject message to a busy session with busy/running, recording nothing", async () => {
        const sessionId = await newSession(agent);
        await send({ sessionId, content: "hold" });
        await holding();
        await expect(send({ sessionId, content: "now", whenBusy: "reject" })).rejects.toMatchObject({
          code: "busy",
          retryable: true,
          details: { reason: "running" },
        });
        expect((await history(agent, sessionId)).filter((entry) => entry.kind === "user")).toHaveLength(1);
        subject.release();
      });

      it("takes a steer while the session is still busy, ahead of the queued messages", async () => {
        const sessionId = await newSession(agent);
        const running = await send({ sessionId, content: "hold" });
        await holding();
        const queued = await send({ sessionId, content: "later" });
        const steer = await send({ sessionId, content: "steer", whenBusy: "steer" });
        expect(steer.status).toBe("queued");
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        subject.release();
        const events = await watching.until(doneOf(running));
        await watching.close();
        expect(entriesIn(events).some((entry) => messageOf(entry) === steer.id)).toBe(true);
        await ended(agent, steer);
        await ended(agent, queued);
      });

      it("takes a steer the agent did not take before it stopped no later than the queued messages", async () => {
        const sessionId = await newSession(agent);
        const running = await send({ sessionId, content: "slow" });
        await untilStatus(agent, running, "running");
        const queued = await send({ sessionId, content: "later" });
        const steer = await send({ sessionId, content: "steer", whenBusy: "steer" });
        await ended(agent, queued);
        await ended(agent, steer);
        const all = await history(agent, sessionId);
        const at = (message: Message) => all.findIndex((entry) => messageOf(entry) === message.id);
        const queuedAnswered = all.findIndex((entry, index) => index > at(queued) && entry.kind === "assistant");
        expect(at(steer)).toBeGreaterThan(at(running));
        expect(at(steer)).toBeLessThan(queuedAnswered);
      });

      it("takes a message at once in an idle session, whatever whenBusy says", async () => {
        for (const whenBusy of ["queue", "steer", "reject"] as const) {
          const message = await send({ sessionId: await newSession(agent), content: "hi", whenBusy });
          expect(message.status).not.toBe("queued");
          expect((await ended(agent, message)).status).toBe("completed");
        }
      });

      it("refuses the 21st queued message with busy/queue_full", async () => {
        const sessionId = await newSession(agent);
        await send({ sessionId, content: "hold" });
        await holding();
        for (let i = 0; i < 20; i++) await send({ sessionId, content: `q${i}` });
        await expect(send({ sessionId, content: "one too many" })).rejects.toMatchObject({
          code: "busy",
          details: { reason: "queue_full" },
        });
        subject.release();
      });

      it("refuses a message past the process's capacity with busy/capacity", async () => {
        agent = await subject.start({ inFlightPerProcess: 2 });
        await send({ sessionId: await newSession(agent), content: "hold" });
        await send({ sessionId: await newSession(agent), content: "hold" });
        await expect(send({ sessionId: await newSession(agent), content: "hi" })).rejects.toMatchObject({
          code: "busy",
          details: { reason: "capacity" },
        });
        subject.release();
      });
    });

    describe("Idempotency", () => {
      it("keeps a key as it was given, whatever its characters", async () => {
        const sessionId = await newSession(agent);
        for (const idempotencyKey of ["订单-1", " padded ", "chat/42 #7?x=1%", "100%"]) {
          const sent = await send({ sessionId, content: "hi", idempotencyKey });
          expect(sent.idempotencyKey).toBe(idempotencyKey);
          expect(await agent.messages.get({ sessionId, idempotencyKey })).toMatchObject({ id: sent.id });
          expect(await send({ sessionId, content: "again", idempotencyKey })).toMatchObject({ id: sent.id });
        }
      });

      it("returns a key's message while it is queued, running and ended, recording it once", async () => {
        const sessionId = await newSession(agent);
        const running = await send({ sessionId, content: "hold", idempotencyKey: "first" });
        await holding();
        const queued = await send({ sessionId, content: "hi", idempotencyKey: "second" });
        expect(await send({ sessionId, content: "other", idempotencyKey: "second" })).toEqual(queued);
        expect(await send({ sessionId, content: "hold", idempotencyKey: "first" })).toMatchObject({
          id: running.id,
          status: "running",
          idempotencyKey: "first",
        });
        subject.release();
        const end = await ended(agent, queued);
        expect(await send({ sessionId, content: "hi", idempotencyKey: "second" })).toEqual(end);
        const users = (await history(agent, sessionId)).filter((entry) => entry.kind === "user");
        expect(users.map(messageOf)).toEqual([running.id, queued.id]);
      });

      it("makes one message of concurrent sends with one key", async () => {
        const sessionId = await newSession(agent);
        const messages = await Promise.all(
          Array.from({ length: 5 }, () => send({ sessionId, content: "hi", idempotencyKey: "once" })),
        );
        expect(new Set(messages.map((message) => message.id)).size).toBe(1);
        await ended(agent, messages[0] as Message);
        expect((await history(agent, sessionId)).filter((entry) => entry.kind === "user")).toHaveLength(1);
      });

      it("keeps a key to its session", async () => {
        const one = await send({ sessionId: await newSession(agent), content: "hi", idempotencyKey: "k" });
        const other = await send({ sessionId: await newSession(agent), content: "hi", idempotencyKey: "k" });
        expect(other.id).not.toBe(one.id);
      });
    });

    describe("Messages", () => {
      it("follows a message through queued, running and its end, by its id and by its key", async () => {
        const sessionId = await newSession(agent);
        const running = await send({ sessionId, content: "hold" });
        await holding();
        const message = await send({ sessionId, content: "hi", idempotencyKey: "tracked" });
        const byKey = () => agent.messages.get({ sessionId, idempotencyKey: "tracked" });
        expect(await byKey()).toEqual({ id: message.id, sessionId, idempotencyKey: "tracked", status: "queued" });
        expect(await agent.messages.get(byId(running))).toMatchObject({
          status: "running",
          entryId: expect.any(String),
        });
        subject.release();
        const end = await ended(agent, message);
        expect(await byKey()).toEqual(end);
        expect(end).toMatchObject({ idempotencyKey: "tracked", status: "completed" });
        const other = await newSession(agent);
        for (const key of [
          { sessionId, messageId: "no-such-message" },
          { sessionId, idempotencyKey: "never-sent" },
          { sessionId: "no-such-session", messageId: message.id },
          { sessionId: other, messageId: message.id },
        ]) {
          await expect(agent.messages.get(key)).rejects.toMatchObject({ code: "not_found" });
        }
      });

      it("ends a message whose Caller never waits or watches", async () => {
        const message = await send({ sessionId: await newSession(agent), content: "hi" });
        await untilStatus(agent, message, "completed");
      });

      it("cancels the running message and withdraws the queued ones, answering once the stop is recorded", async () => {
        const sessionId = await newSession(agent);
        expect(await agent.sessions.cancel(sessionId)).toEqual({ stopped: [] });
        const running = await send({ sessionId, content: "stubborn" });
        await holding();
        const queued = await send({ sessionId, content: "hi" });
        // A tool that ignores its abort signal keeps running: the answer does not wait for it.
        expect(await agent.sessions.cancel(sessionId)).toEqual({ stopped: [running.id, queued.id] });
        await stopRecorded();
        expect(subject.held()).toBe(1);
        expect(await agent.messages.get(byId(queued))).toEqual({ ...queued, status: "canceled" });
        expect((await agent.messages.get(byId(running))).status).toBe("running");
        // A second cancel finds the same stop recorded.
        expect(await agent.sessions.cancel(sessionId)).toEqual({ stopped: [running.id] });
        subject.release();
        const end = await ended(agent, running);
        expect(end.status).toBe("canceled");
        expect(end).not.toHaveProperty("answer");
        await expect(agent.sessions.cancel("no-such-session")).rejects.toMatchObject({ code: "not_found" });
      });

      it("takes the messages sent after a failed one, and after a cancel", async () => {
        const sessionId = await newSession(agent);
        await send({ sessionId, content: "hold" });
        await holding();
        const failing = await send({ sessionId, content: "fail" });
        const after = await send({ sessionId, content: "after" });
        subject.release();
        expect(await ended(agent, failing)).toMatchObject({ status: "failed", error: { code: "model_error" } });
        expect((await ended(agent, after)).status).toBe("completed");
        await send({ sessionId, content: "stubborn" });
        await holding();
        await agent.sessions.cancel(sessionId);
        const next = await send({ sessionId, content: "next" });
        subject.release();
        expect((await ended(agent, next)).status).toBe("completed");
      });

      it("gives an answer only to a completed or incomplete message, never a reply whose tool calls ran", async () => {
        const sessionId = await newSession(agent);
        const completed = await ended(agent, await send({ sessionId, content: "hi" }));
        expect(completed).toMatchObject({ status: "completed", answer: { text: "answer: hi" } });
        const cut = await ended(agent, await send({ sessionId, content: "long" }));
        expect(cut).toMatchObject({ status: "incomplete", answer: { text: "cut short" } });
        const failed = await ended(agent, await send({ sessionId, content: "fail" }));
        expect(failed.status).toBe("failed");
        expect(failed).not.toHaveProperty("answer");
        const finished = await ended(agent, await send({ sessionId, content: "finish" }));
        expect(finished.status).toBe("completed");
        expect(finished).not.toHaveProperty("answer");
        const tool = await ended(agent, await send({ sessionId, content: "effect" }));
        expect(tool.answer?.text).toBe("answer: effect");
      });

      it("ends a message failed with auth_required when its model provider has no credential", async () => {
        agent = await subject.start({ signedOut: true });
        const end = await ended(agent, await send({ sessionId: await newSession(agent), content: "hi" }));
        expect(end).toMatchObject({ status: "failed", error: { code: "auth_required", retryable: false } });
        expect(end).not.toHaveProperty("answer");
      });
    });

    describe("Restart", () => {
      it("answers a message accepted just before a restart after it, and get finds it", async () => {
        const sessionId = await newSession(agent);
        const message = await send({ sessionId, content: "hold" });
        await holding();
        agent = await subject.restart();
        expect((await ended(agent, message)).status).toBe("completed");
      });

      it("keeps the queued messages, and takes them", async () => {
        const sessionId = await newSession(agent);
        await send({ sessionId, content: "hold" });
        await holding();
        const queued = [await send({ sessionId, content: "a" }), await send({ sessionId, content: "b" })];
        agent = await subject.restart();
        for (const message of queued) expect((await ended(agent, message)).status).toBe("completed");
      });

      it("ends a message a cancel was stopping when the process stopped canceled after the restart", async () => {
        const sessionId = await newSession(agent);
        const running = await send({ sessionId, content: "stubborn" });
        await holding();
        await agent.sessions.cancel(sessionId);
        agent = await subject.restart();
        const end = await ended(agent, running);
        expect(end.status).toBe("canceled");
        expect(end).not.toHaveProperty("answer");
      });

      it("does not redo a tool call the process stopped after its effect", async () => {
        const sessionId = await newSession(agent);
        const message = await send({ sessionId, content: "mark" });
        await holding();
        expect(subject.effects()).toBe(1);
        agent = await subject.restart();
        expect((await ended(agent, message)).status).toBe("completed");
        expect(subject.effects()).toBe(1);
      });
    });

    describe("Watching", () => {
      it("replays nothing without after, every entry from start, and the entries after a cursor", async () => {
        const sessionId = await newSession(agent);
        await ended(agent, await send({ sessionId, content: "one" }));
        await ended(agent, await send({ sessionId, content: "two" }));
        const all = await history(agent, sessionId);
        expect(all).toHaveLength(4);

        const none = attach(agent, sessionId);
        expect(await none.until(isState)).toMatchObject([
          { type: "state", session: { id: sessionId, status: "idle" } },
        ]);
        await none.close();

        const fromStart = attach(agent, sessionId, { after: "start" });
        const replayed = await fromStart.until(isState);
        await fromStart.close();
        expect(entriesIn(replayed)).toEqual(all);
        expect(replayed.at(-1)?.type).toBe("state");

        const fromCursor = attach(agent, sessionId, { after: (all[1] as Entry).id });
        const rest = await fromCursor.until(isState);
        await fromCursor.close();
        expect(entriesIn(rest)).toEqual(all.slice(2));
      });

      it("delivers a message sent after the watch opened, from its user entry to its done", async () => {
        const sessionId = await newSession(agent);
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        const message = await send({ sessionId, content: "hi" });
        const events = await watching.until(doneOf(message));
        await watching.close();
        const entries = entriesIn(events);
        expect(entries.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
        expect(messageOf(entries[0] as Entry)).toBe(message.id);
        expect(events.at(-1)).toEqual({ type: "done", message: await ended(agent, message) });
      });

      it("sends a message's done before the user entry of the message taken after it", async () => {
        const sessionId = await newSession(agent);
        const running = await send({ sessionId, content: "hold" });
        await holding();
        const queued = await send({ sessionId, content: "next" });
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        subject.release();
        const events = await watching.until(doneOf(queued));
        await watching.close();
        const doneAt = events.findIndex(doneOf(running));
        const takenAt = events.findIndex((event) => event.type === "entry" && messageOf(event.entry) === queued.id);
        expect(doneAt).toBeGreaterThanOrEqual(0);
        expect(doneAt).toBeLessThan(takenAt);
        expect(events.filter((event) => event.type === "state")).toHaveLength(0);
      });

      it("gives a Caller attached mid-answer the reply so far, which the deltas continue", async () => {
        const sessionId = await newSession(agent);
        const message = await send({ sessionId, content: "slow" });
        await vi.waitFor(async () => expect((await agent.sessions.get(sessionId)).reply?.text).toBeTruthy(), {
          timeout: 5000,
          interval: 10,
        });
        const watching = attach(agent, sessionId);
        const [state] = await watching.until(isState);
        const events = await watching.until(doneOf(message));
        await watching.close();
        const shown = state?.type === "state" ? (state.session.reply?.text ?? "") : "";
        const deltas = events.flatMap((event) =>
          event.type === "delta" && event.channel === "text" ? [event.text] : [],
        );
        const answer = entriesIn(events).find((entry) => entry.kind === "assistant") as Entry;
        expect(shown).not.toBe("");
        expect(deltas.length).toBeGreaterThan(0);
        expect((answer.data as { text: string }).text.startsWith(shown + deltas.join(""))).toBe(true);
      });

      it("delivers a running tool's start and its status lines, a nested call as its caller's", async () => {
        const sessionId = await newSession(agent);
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        const streamed = await send({ sessionId, content: "stream" });
        const events = await watching.until(doneOf(streamed));
        const nested = await send({ sessionId, content: "nested" });
        const more = await watching.until(doneOf(nested));
        await watching.close();

        const started = events.find((event) => event.type === "tool_started");
        expect(started).toMatchObject({ type: "tool_started", name: "stream", args: {} });
        const callId = (started as { toolCallId: string }).toolCallId;
        const lines = events.flatMap((event) =>
          event.type === "tool_progress" && event.toolCallId === callId ? [event.text] : [],
        );
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.every((line) => ["one", "two", "three of the lines"].includes(line))).toBe(true);
        expect(new Set(lines).size).toBe(lines.length);
        const result = events.findIndex((event) => event.type === "entry" && event.entry.kind === "tool_result");
        expect(events.indexOf(started as SessionEvent)).toBeLessThan(result);
        expect(events.slice(result).some((event) => event.type === "tool_progress")).toBe(false);

        const outer = more.find((event) => event.type === "tool_started");
        expect(outer).toMatchObject({ name: "nested" });
        expect(more.filter((event) => event.type === "tool_started")).toHaveLength(1);
        expect(more).toContainEqual({
          type: "tool_progress",
          toolCallId: (outer as { toolCallId: string }).toolCallId,
          text: "lookup London",
        });
      });

      it("explains a quiet gap with retrying before the attempt that answers", async () => {
        const sessionId = await newSession(agent);
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        const message = await send({ sessionId, content: "flaky" });
        const events = await watching.until(doneOf(message));
        await watching.close();
        const retry = events.findIndex((event) => event.type === "retrying");
        expect(events[retry]).toMatchObject({
          type: "retrying",
          attempt: 1,
          maxAttempts: expect.any(Number),
          delayMs: expect.any(Number),
          reason: expect.stringContaining("overloaded"),
        });
        const answer = events.findIndex(
          (event) =>
            event.type === "entry" &&
            event.entry.kind === "assistant" &&
            (event.entry.data as { stop?: unknown }).stop === undefined,
        );
        expect(retry).toBeLessThan(answer);
        expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "completed" } });
      });

      it("streams the model's thinking on its own channel, never folded into the answer", async () => {
        const sessionId = await newSession(agent);
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        const message = await send({ sessionId, content: "ponder" });
        const events = await watching.until(doneOf(message));
        await watching.close();
        const deltas = (channel: "text" | "thinking") =>
          events.flatMap((event) => (event.type === "delta" && event.channel === channel ? [event.text] : []));
        const reply = entriesIn(events).find((entry) => entry.kind === "assistant") as Entry;
        const data = reply.data as { text: string; thinking?: string };
        expect(deltas("thinking").length).toBeGreaterThan(0);
        expect(data.thinking?.startsWith(deltas("thinking").join(""))).toBe(true);
        expect(data.text).toBe("answer: ponder");
        expect(data.text.startsWith(deltas("text").join(""))).toBe(true);
      });

      it("delivers each entry exactly once across a reconnect after the last entry it had", async () => {
        const sessionId = await newSession(agent);
        await ended(agent, await send({ sessionId, content: "one" }));
        const first = attach(agent, sessionId, { after: "start" });
        const had = entriesIn(await first.until(isState));
        await first.close();
        await ended(agent, await send({ sessionId, content: "two" }));
        const second = attach(agent, sessionId, { after: (had.at(-1) as Entry).id });
        const more = entriesIn(await second.until(isState));
        await second.close();
        expect([...had, ...more]).toEqual(await history(agent, sessionId));
      });

      it("ends with stream_error when the storage fails", async () => {
        const sessionId = await newSession(agent);
        await send({ sessionId, content: "hold" });
        await holding();
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        subject.failStorage();
        subject.release();
        const rest = await watching.rest();
        expect(rest.at(-1)).toMatchObject({ type: "stream_error", error: { code: "unavailable" } });
      });

      it("rejects an unknown session or cursor with not_found", async () => {
        await expect(attach(agent, "no-such-session").next()).rejects.toMatchObject({ code: "not_found" });
        const sessionId = await newSession(agent);
        await expect(attach(agent, sessionId, { after: "nope" }).next()).rejects.toMatchObject({ code: "not_found" });
      });

      it("lets go on its signal: the read waiting then rejects with its reason", async () => {
        const sessionId = await newSession(agent);
        const controller = new AbortController();
        const watching = attach(agent, sessionId, { signal: controller.signal });
        await watching.until(isState);
        const waiting = watching.next();
        const reason = new Error("the Caller left");
        controller.abort(reason);
        await expect(waiting).rejects.toBe(reason);
      });
    });

    describe("Reading", () => {
      it("pages by after, before and limit, the newest page first", async () => {
        const sessionId = await newSession(agent);
        for (const word of ["one", "two", "three"]) await ended(agent, await send({ sessionId, content: word }));
        const all = await history(agent, sessionId);
        expect(all).toHaveLength(6);
        expect(all[0]).toEqual({
          id: expect.any(String),
          timestamp: expect.any(Number),
          kind: "user",
          data: expect.any(Object),
        });

        const newest = await agent.sessions.entries(sessionId, { limit: 2 });
        expect(newest).toEqual({ data: all.slice(4), prev: all[4]?.id });
        const older = await agent.sessions.entries(sessionId, { before: all[4]?.id, limit: 2 });
        expect(older).toEqual({ data: all.slice(2, 4), prev: all[2]?.id, next: all[3]?.id });
        const oldest = await agent.sessions.entries(sessionId, { before: all[2]?.id, limit: 5 });
        expect(oldest).toEqual({ data: all.slice(0, 2), next: all[1]?.id });
        const after = await agent.sessions.entries(sessionId, { after: all[1]?.id, limit: 2 });
        expect(after).toEqual({ data: all.slice(2, 4), prev: all[2]?.id, next: all[3]?.id });

        for (const options of [{ limit: 0 }, { limit: 501 }, { after: all[0]?.id, before: all[2]?.id }]) {
          await expect(agent.sessions.entries(sessionId, options)).rejects.toMatchObject({ code: "invalid_request" });
        }
        await expect(agent.sessions.entries(sessionId, { after: "nope" })).rejects.toMatchObject({
          code: "not_found",
        });
        await expect(agent.sessions.entries("no-such-session")).rejects.toMatchObject({ code: "not_found" });
      });

      it("names a taken message in its user entry, and gives every assistant entry its usage", async () => {
        const sessionId = await newSession(agent);
        const message = await send({ sessionId, content: "effect", idempotencyKey: "named" });
        await ended(agent, message);
        const all = await history(agent, sessionId);
        expect(all[0]).toMatchObject({ kind: "user", data: { content: text("effect"), messageId: message.id } });
        const replies = all.filter((entry) => entry.kind === "assistant");
        expect(replies).toHaveLength(2);
        for (const reply of replies) {
          expect(reply.data).toMatchObject({
            usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
          });
        }
        expect(all.map((entry) => entry.kind)).toEqual(["user", "assistant", "tool_result", "assistant"]);
        const cut = await ended(agent, await send({ sessionId, content: "long" }));
        const [reply] = (await agent.sessions.entries(sessionId, { limit: 1 })).data;
        expect(reply).toMatchObject({ id: cut.answer?.entryId, kind: "assistant", data: { stop: "max_tokens" } });
      });

      it("counts a session's own spend, a fork's from nothing, and the instance's", async () => {
        const sessionId = await newSession(agent);
        const empty = { models: {}, tools: {} };
        expect(await agent.sessions.get(sessionId)).toMatchObject({ usage: empty });
        await ended(agent, await send({ sessionId, content: "hi" }));
        const spent = await agent.sessions.get(sessionId);
        const calls = Object.values(spent.usage.models);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.outputTokens).toBeGreaterThan(0);
        const reply = (await history(agent, sessionId)).find((entry) => entry.kind === "assistant") as Entry;
        expect(calls[0]).toMatchObject((reply.data as { usage: object }).usage);
        const fork = await agent.sessions.create({ forkFrom: { sessionId } });
        expect(fork.usage).toEqual(empty);
        const watching = attach(agent, sessionId);
        const [state] = await watching.until(isState);
        await watching.close();
        expect(state).toMatchObject({ type: "state", session: { usage: spent.usage } });
        await ended(agent, await send({ sessionId: fork.id, content: "more" }));
        const instance = await agent.usage();
        const [model] = Object.keys(spent.usage.models);
        expect(instance.models[model as string]?.outputTokens).toBeGreaterThan(calls[0]?.outputTokens as number);
      });

      it("moves the session from idle to running and back", async () => {
        const sessionId = await newSession(agent);
        expect(await agent.sessions.get(sessionId)).toMatchObject({ id: sessionId, status: "idle" });
        const running = await send({ sessionId, content: "hold" });
        await holding();
        expect(await agent.sessions.get(sessionId)).toMatchObject({ status: "running" });
        subject.release();
        await ended(agent, running);
        expect(await agent.sessions.get(sessionId)).toMatchObject({ status: "idle" });
        await expect(agent.sessions.get("no-such-session")).rejects.toMatchObject({ code: "not_found" });
      });

      it("returns the bytes of an image a message carried, through its ref", async () => {
        const sessionId = await newSession(agent);
        const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } as const;
        await ended(agent, await send({ sessionId, content: [{ type: "text", text: "look" }, image] }));
        const [user] = await history(agent, sessionId);
        const part = ((user as Entry).data as { content: ContentPart[] }).content[1];
        expect(part).toMatchObject({ type: "image", mimeType: "image/png", ref: expect.any(String) });
        const ref = (part as { ref: string }).ref;
        const got = await agent.sessions.attachment(sessionId, ref);
        expect(got.mimeType).toBe("image/png");
        expect(Buffer.from(got.data).toString("base64")).toBe(image.data);
        await expect(agent.sessions.attachment(sessionId, "nope")).rejects.toMatchObject({ code: "not_found" });
        await expect(agent.sessions.attachment(await newSession(agent), ref)).rejects.toMatchObject({
          code: "not_found",
        });
      });
    });

    describe("Streaming a message", () => {
      const drain = async (events: AsyncIterable<MessageStreamEvent>) => {
        const out: MessageStreamEvent[] = [];
        for await (const event of events) out.push(event);
        return out;
      };
      const replies = (events: MessageStreamEvent[]) =>
        entriesIn(events).map((entry) => `${entry.kind}:${(entry.data as { text?: string }).text ?? ""}`);
      const firstOf = (events: MessageStreamEvent[]) => {
        const [first] = events;
        if (first?.type !== "message") throw new Error(`the stream began with ${JSON.stringify(first)}`);
        return first.message;
      };

      it("delivers a new message as recorded, then its events from its user entry through its done", async () => {
        const sessionId = await newSession(agent);
        const events = await drain(agent.messages.stream({ sessionId, content: "hi" }));
        const message = firstOf(events);
        expect(message).toMatchObject({ sessionId, status: expect.stringMatching(/^(queued|running)$/) });
        expect(replies(events)).toEqual(["user:", "assistant:answer: hi"]);
        expect(events.at(-1)).toEqual({ type: "done", message: await ended(agent, message) });
      });

      it("delivers only its own message's events for a message queued behind another", async () => {
        const sessionId = await newSession(agent);
        await send({ sessionId, content: "hold" });
        await holding();
        const streaming = drain(agent.messages.stream({ sessionId, content: "next" }));
        await vi.waitFor(async () => expect((await history(agent, sessionId)).length).toBeGreaterThan(0));
        subject.release();
        const events = await streaming;
        expect(firstOf(events).status).toBe("queued");
        expect(replies(events)).toEqual(["user:", "assistant:answer: next"]);
        expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "completed" } });
      });

      it("delivers a queued message sent again by its key once it is taken", async () => {
        const sessionId = await newSession(agent);
        await send({ sessionId, content: "hold" });
        await holding();
        const first = await send({ sessionId, content: "next", idempotencyKey: "k" });
        const streaming = drain(agent.messages.stream({ sessionId, content: "next", idempotencyKey: "k" }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        subject.release();
        const events = await streaming;
        expect(firstOf(events)).toEqual(first);
        expect(replies(events)).toEqual(["user:", "assistant:answer: next"]);
      });

      it("delivers a running message sent again from its user entry, what it already wrote included", async () => {
        const sessionId = await newSession(agent);
        await send({ sessionId, content: "hold", idempotencyKey: "k" });
        await holding();
        const iterator = agent.messages
          .stream({ sessionId, content: "hold", idempotencyKey: "k" })
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.value).toMatchObject({ type: "message", message: { status: "running" } });
        const events: MessageStreamEvent[] = [first.value as MessageStreamEvent];
        // Released once its state is out: one that ended before the replay was read is delivered as ended.
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
          events.push(next.value);
          if (next.value.type === "state") break;
        }
        subject.release();
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) events.push(next.value);
        expect(replies(events)).toEqual(["user:", "assistant:", "tool_result:", "assistant:answer: hold"]);
        expect(events.filter((event) => event.type === "state")).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ type: "done", message: { answer: { text: "answer: hold" } } });
      });

      it("delivers an ended message sent again: its entries through its answer, then its done", async () => {
        const sessionId = await newSession(agent);
        await ended(agent, await send({ sessionId, content: "effect", idempotencyKey: "k" }));
        await ended(agent, await send({ sessionId, content: "after" }));
        const events = await drain(agent.messages.stream({ sessionId, content: "effect", idempotencyKey: "k" }));
        const message = firstOf(events);
        expect(message.status).toBe("completed");
        expect(replies(events)).toEqual(["user:", "assistant:", "tool_result:", "assistant:answer: effect"]);
        expect(events.at(-1)).toEqual({ type: "done", message });
        await ended(agent, await send({ sessionId, content: "fail", idempotencyKey: "failed" }));
        const failed = await drain(agent.messages.stream({ sessionId, content: "fail", idempotencyKey: "failed" }));
        expect(replies(failed)).toEqual(["user:"]);
        expect(failed.at(-1)).toEqual({ type: "done", message: firstOf(failed) });
      });

      it("ends with the message's canceled done when it is cancelled", async () => {
        const sessionId = await newSession(agent);
        const events = drain(agent.messages.stream({ sessionId, content: "hold" }));
        await holding();
        await agent.sessions.cancel(sessionId);
        expect((await events).at(-1)).toMatchObject({ type: "done", message: { status: "canceled" } });
      });

      it("rejects its first read with the send's refusal, recording nothing", async () => {
        await expect(
          drain(agent.messages.stream({ sessionId: "no-such-session", content: "hi" })),
        ).rejects.toMatchObject({ code: "not_found" });
        const sessionId = await newSession(agent);
        await expect(drain(agent.messages.stream({ sessionId, content: [] }))).rejects.toMatchObject({
          code: "invalid_request",
        });
        await send({ sessionId, content: "hold" });
        await holding();
        await expect(
          drain(agent.messages.stream({ sessionId, content: "now", whenBusy: "reject" })),
        ).rejects.toMatchObject({ code: "busy" });
        expect((await history(agent, sessionId)).filter((entry) => entry.kind === "user")).toHaveLength(1);
        subject.release();
      });

      it("lets go on its signal, rejecting the read waiting then with its reason, and the message goes on", async () => {
        const sessionId = await newSession(agent);
        await send({ sessionId, content: "hold" });
        await holding();
        // Queued behind the held message, the stream is quiet after its first event: the next read waits.
        const controller = new AbortController();
        const iterator = agent.messages
          .stream({ sessionId, content: "later" }, { signal: controller.signal })
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        const message = (first.value as { message: Message }).message;
        expect(message.status).toBe("queued");
        const waiting = iterator.next();
        const reason = new Error("the Caller left");
        controller.abort(reason);
        await expect(waiting).rejects.toBe(reason);
        await expect(iterator.next()).rejects.toBe(reason);
        subject.release();
        expect((await ended(agent, message)).status).toBe("completed");
      });
    });

    describe("Listing", () => {
      const order = async () => (await agent.sessions.list()).data.map((session) => session.id);

      it("lists every session as it is, most recently created first", async () => {
        const a = await newSession(agent);
        const b = await newSession(agent);
        const c = (await send({ sessionId: await newSession(agent), content: "hello" })).sessionId;
        expect(await order()).toEqual([c, b, a]);
        expect((await agent.sessions.list()).data[1]).toEqual(await agent.sessions.get(b));
      });

      it("moves a session to the front when it accepts a message, and when it writes an entry", async () => {
        const a = await newSession(agent);
        const held = await send({ sessionId: a, content: "hold" });
        await holding();
        const b = await newSession(agent);
        expect(await order()).toEqual([b, a]);
        const queued = await send({ sessionId: a, content: "later" });
        expect(queued.status).toBe("queued");
        expect(await order()).toEqual([a, b]);
        const c = await newSession(agent);
        expect(await order()).toEqual([c, a, b]);
        subject.release();
        await ended(agent, held);
        await ended(agent, queued);
        expect(await order()).toEqual([a, c, b]);
      });

      it("pages by after and limit, repeating no session and skipping none", async () => {
        const created: string[] = [];
        for (let i = 0; i < 5; i++) created.unshift(await newSession(agent));
        const first = await agent.sessions.list({ limit: 2 });
        expect(first.data.map(({ id }) => id)).toEqual(created.slice(0, 2));
        const second = await agent.sessions.list({ limit: 2, after: first.next as string });
        expect(second.data.map(({ id }) => id)).toEqual(created.slice(2, 4));
        const last = await agent.sessions.list({ limit: 2, after: second.next as string });
        expect(last.data.map(({ id }) => id)).toEqual(created.slice(4));
        expect(last.next).toBeUndefined();
      });

      it("refuses a limit out of range and what it cannot read as one of its cursors, a session id included", async () => {
        const sessionId = await newSession(agent);
        for (const options of [
          { limit: 0 },
          { limit: 501 },
          { limit: 1.5 },
          { after: "no-such-cursor" },
          { after: sessionId },
        ]) {
          await expect(agent.sessions.list(options)).rejects.toMatchObject({ code: "invalid_request" });
        }
      });

      it("keeps the order after a restart", async () => {
        const a = await newSession(agent);
        await ended(agent, await send({ sessionId: await newSession(agent), content: "hello" }));
        await ended(agent, await send({ sessionId: a, content: "again" }));
        const before = await order();
        agent = await subject.restart();
        expect(await order()).toEqual(before);
        expect(before[0]).toBe(a);
      });
    });

    describe("Sessions", () => {
      it("forks the history up to an entry and none of the messages, leaving the source unchanged", async () => {
        const sessionId = await newSession(agent);
        const first = await send({ sessionId, content: "one" });
        await ended(agent, first);
        await ended(agent, await send({ sessionId, content: "two" }));
        const source = await history(agent, sessionId);
        const fork = await agent.sessions.create({ forkFrom: { sessionId, entryId: (source[1] as Entry).id } });
        expect(await history(agent, fork.id)).toEqual(source.slice(0, 2));
        await expect(agent.messages.get({ sessionId: fork.id, messageId: first.id })).rejects.toMatchObject({
          code: "not_found",
        });
        const own = await send({ sessionId: fork.id, content: "three" });
        expect((await ended(agent, own)).answer?.text).toBe("answer: three");
        expect((await history(agent, fork.id)).slice(0, 2)).toEqual(source.slice(0, 2));
        expect(await history(agent, sessionId)).toEqual(source);

        const whole = await agent.sessions.create({ forkFrom: { sessionId } });
        expect(await history(agent, whole.id)).toEqual(source);
      });

      it("takes a fork's settings from its source, each one given replacing the inherited one", async () => {
        const sessionId = (await agent.sessions.create({ thinkingLevel: "low", instructions: "Be brief." })).id;
        const fork = await agent.sessions.create({ forkFrom: { sessionId }, thinkingLevel: "high" });
        expect(fork).toMatchObject({ thinkingLevel: "high", instructions: "Be brief." });
      });

      it("updates a session's settings, read back and used from its next message", async () => {
        const chosen = await agent.sessions.create({ thinkingLevel: "low" });
        expect(chosen).toMatchObject({ thinkingLevel: "low" });
        expect(chosen).not.toHaveProperty("model");

        const sessionId = await newSession(agent);
        await ended(agent, await send({ sessionId, content: "one" }));
        const { model } = await agent.sessions.get(sessionId);
        if (model === undefined) throw new Error("the session's first message took no model");
        expect(await agent.sessions.update(sessionId, { thinkingLevel: "high" })).toMatchObject({
          model,
          thinkingLevel: "high",
        });
        const watching = attach(agent, sessionId);
        expect((await watching.until(isState)).at(-1)).toMatchObject({ session: { model, thinkingLevel: "high" } });
        await watching.close();

        // Stored as given, as at creation: a model the agent lacks refuses the next message, not the change.
        const elsewhere = { provider: "nowhere", modelId: "none" };
        expect(await agent.sessions.update(sessionId, { model: elsewhere })).toMatchObject({ model: elsewhere });
        await expect(send({ sessionId, content: "two" })).rejects.toMatchObject({
          code: "missing_model",
          details: { model: "nowhere/none" },
        });
        await agent.sessions.update(sessionId, { model });
        expect((await ended(agent, await send({ sessionId, content: "three" }))).answer?.text).toBe("answer: three");

        expect(await agent.sessions.update(sessionId, { instructions: "Answer in French." })).toMatchObject({
          instructions: "Answer in French.",
        });
        const instructed = await ended(agent, await send({ sessionId, content: "instructions" }));
        expect(instructed.answer?.text).toContain("Answer in French.");
        const cleared = await agent.sessions.update(sessionId, { instructions: null, thinkingLevel: null });
        expect(cleared).not.toHaveProperty("instructions");
        const plain = await ended(agent, await send({ sessionId, content: "instructions" }));
        expect(plain.answer?.text).not.toContain("Answer in French.");
      });

      it("enables only the tools a session names, among the agent's own", async () => {
        const tools = (await agent.info()).tools.map(({ name }) => name);
        expect(tools).toEqual(expect.arrayContaining(["hold", "effect", "stream"]));
        const sessionId = (await agent.sessions.create({ tools: ["effect", "hold"] })).id;
        expect(await agent.sessions.get(sessionId)).toMatchObject({ tools: ["effect", "hold"] });
        expect((await ended(agent, await send({ sessionId, content: "effect" }))).answer?.text).toBe("answer: effect");
        await expect(agent.sessions.create({ tools: ["no-such-tool"] })).rejects.toMatchObject({
          code: "invalid_request",
          details: { tools: ["no-such-tool"] },
        });
        await expect(agent.sessions.update(sessionId, { tools: ["effect", "nope"] })).rejects.toMatchObject({
          code: "invalid_request",
        });

        // A later deployment without one of them refuses the session's next message, until its tools change.
        agent = await subject.restart({ removeTools: ["hold"] });
        await expect(send({ sessionId, content: "effect" })).rejects.toMatchObject({
          code: "missing_tool",
          retryable: false,
          details: { tools: ["hold"] },
        });
        expect((await history(agent, sessionId)).filter((entry) => entry.kind === "user")).toHaveLength(1);
        expect(await agent.sessions.update(sessionId, { tools: null })).not.toHaveProperty("tools");
        expect((await ended(agent, await send({ sessionId, content: "hi" }))).status).toBe("completed");
      });

      it("refuses an unknown session with not_found, and an update of nothing with invalid_request", async () => {
        await expect(agent.sessions.update("nope", { thinkingLevel: "high" })).rejects.toMatchObject({
          code: "not_found",
        });
        const sessionId = await newSession(agent);
        await expect(agent.sessions.update(sessionId, {})).rejects.toMatchObject({ code: "invalid_request" });
        await expect(agent.sessions.update(sessionId, { thinkingLevel: "loud" } as never)).rejects.toMatchObject({
          code: "invalid_request",
        });
      });

      it("refuses a fork of an unknown session or entry with not_found", async () => {
        await expect(agent.sessions.create({ forkFrom: { sessionId: "nope" } })).rejects.toMatchObject({
          code: "not_found",
        });
        const sessionId = await newSession(agent);
        await expect(agent.sessions.create({ forkFrom: { sessionId, entryId: "nope" } })).rejects.toMatchObject({
          code: "not_found",
        });
      });

      it("compacts a session on request, and its summary arrives as a compaction entry", async () => {
        const sessionId = await newSession(agent);
        for (const word of ["one", "two", "three"]) await ended(agent, await send({ sessionId, content: word }));
        await agent.sessions.compact(sessionId, { instructions: "Keep the numbers." });
        await vi.waitFor(
          async () => expect((await history(agent, sessionId)).some((entry) => entry.kind === "compaction")).toBe(true),
          { timeout: 5000, interval: 20 },
        );
        await expect(agent.sessions.compact("nope")).rejects.toMatchObject({ code: "not_found" });
      });
    });

    describe("Info", () => {
      it("says what the agent offers: its commands, tools and models, and the model a session answers with", async () => {
        const info = await agent.info();
        expect(info).toMatchObject({ name: expect.any(String), defaultModel: expect.any(Object) });
        expect(info.models).toContainEqual(expect.objectContaining(info.defaultModel));
        agent = await subject.start({ signedOut: true });
        expect((await agent.info()).models).toEqual([]);
      });
    });
  });
}
