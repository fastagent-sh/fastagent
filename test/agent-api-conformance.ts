/**
 * The Agent API's conformance suite (docs/design/agent-api.md §9), runnable against any `Agent`. What a message makes
 * the agent do is chosen by its text, which a subject maps onto its harness:
 *
 * - `hold`: a tool call that waits for `release()` and stops when aborted; `stubborn`: one that waits whatever its
 *   abort signal says; `effect`: one whose runs `effects()` counts; `mark`: one that has its counted effect and then
 *   holds; `finish`: one that ends the run without an answer; `stream`: one whose output's lines are `one`, `two`
 *   and `three of the lines`, written over time; `nested`: one that calls `lookup` with
 *   `{ city: "London" }` from inside it. After a tool call, the answer is `answer: <tool>`.
 * - `fail`: the model call fails; `flaky`: it fails once in a way worth retrying, then answers; `long`: the answer is
 *   cut off (`max_tokens`); `slow`: the answer streams slowly; `ponder`: it streams its thinking slowly, then answers.
 * - Anything else is answered `answer: <text the model saw>`. `info().commands` offers `greet`, which a model sees as
 *   `hello <args>`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type StreamResult, stream } from "../src/agent-api-stream.ts";
import type {
  Agent,
  ContentPart,
  DoneMessage,
  Entry,
  InvokeRequest,
  InvokeResult,
  MessageStatus,
  ResumeEvent,
} from "../src/agent-api.ts";

export interface AgentApiSubject {
  /**
   * A fresh agent over fresh storage. `inFlightPerProcess` lowers the messages the process holds; `signedOut` leaves
   * its model provider without a credential.
   */
  start(options?: { inFlightPerProcess?: number; signedOut?: boolean }): Promise<Agent>;
  /** The same storage, opened by a new process after the previous one stopped. */
  restart(): Promise<Agent>;
  /** Lets every `hold` and `stubborn` call of the current process go on. */
  release(): void;
  /** How many `hold` and `stubborn` calls are running now. */
  held(): number;
  /** How many `hold` and `stubborn` calls were told to stop: an abort's stop is recorded before it signals them. */
  signalled(): number;
  effects(): number;
  /** The storage fails every call from now on. */
  failStorage(): void;
  stop(): Promise<void>;
}

type Receipt = Extract<InvokeResult, { ok: true }>;

const text = (value: string): ContentPart[] => [{ type: "text", text: value }];

async function accepted(agent: Agent, request: InvokeRequest): Promise<Receipt> {
  const result = await agent.invoke(request);
  if (!result.ok) throw new Error(`invoke was not accepted: ${JSON.stringify(result)}`);
  return result;
}

async function newSession(agent: Agent): Promise<string> {
  const created = await agent.createSession();
  if (!created.ok) throw new Error(`createSession failed: ${JSON.stringify(created)}`);
  return created.sessionId;
}

async function ended(receipt: Receipt): Promise<DoneMessage> {
  const result = await receipt.wait();
  if (!result.ok) throw new Error(`wait() was unfinished: ${result.unfinished.reason}`);
  return result.message;
}

async function statusOf(agent: Agent, sessionId: string, messageId: string): Promise<MessageStatus | undefined> {
  return agent.getMessage(sessionId, { messageId });
}

async function untilStatus(agent: Agent, sessionId: string, messageId: string, status: MessageStatus["status"]) {
  await vi.waitFor(async () => expect((await statusOf(agent, sessionId, messageId))?.status).toBe(status), {
    timeout: 5000,
    interval: 10,
  });
}

async function getDone(agent: Agent, sessionId: string, messageId: string): Promise<DoneMessage> {
  await untilStatus(agent, sessionId, messageId, "done");
  return (await statusOf(agent, sessionId, messageId)) as DoneMessage;
}

async function history(agent: Agent, sessionId: string): Promise<Entry[]> {
  const out: Entry[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await agent.read(sessionId, { ...(after === undefined ? {} : { after }), limit: 500 });
    if (!page.ok) throw new Error(`read failed: ${JSON.stringify(page)}`);
    if (after === undefined && page.prev !== undefined) {
      // The newest page came first: start again from the oldest.
      const all: Entry[] = [];
      let before: string | undefined = page.entries[0]?.id;
      all.unshift(...page.entries);
      while (before !== undefined) {
        const older = await agent.read(sessionId, { before, limit: 500 });
        if (!older.ok) throw new Error(`read failed: ${JSON.stringify(older)}`);
        all.unshift(...older.entries);
        before = older.prev === undefined ? undefined : older.entries[0]?.id;
      }
      return all;
    }
    out.push(...page.entries);
    if (page.next === undefined) return out;
    after = page.next;
  }
}

/** A `resume` being read: events arrive in order, and `close()` detaches. */
function attach(agent: Agent, sessionId: string, options?: Parameters<Agent["resume"]>[1]) {
  const iterator = agent.resume(sessionId, options)[Symbol.asyncIterator]();
  const seen: ResumeEvent[] = [];
  return {
    seen,
    async until(stop: (event: ResumeEvent) => boolean): Promise<ResumeEvent[]> {
      const out: ResumeEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error(`the stream ended before the event awaited; read ${JSON.stringify(out)}`);
        out.push(next.value);
        seen.push(next.value);
        if (stop(next.value)) return out;
      }
    },
    async rest(): Promise<ResumeEvent[]> {
      const out: ResumeEvent[] = [];
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) out.push(next.value);
      return out;
    },
    close: async () => {
      await iterator.return?.();
    },
  };
}

const isState = (event: ResumeEvent) => event.type === "state";
const doneOf = (messageId: string) => (event: ResumeEvent) =>
  event.type === "done" && event.message.messageId === messageId;
const entriesIn = (events: ResumeEvent[]): Entry[] =>
  events.flatMap((event) => (event.type === "entry" ? [event.entry] : []));
const userMessageOf = (entry: Entry): string | undefined =>
  entry.kind === "user_message" ? ((entry.data as { messageId?: string }).messageId ?? undefined) : undefined;

export function agentApiConformance(name: string, subject: AgentApiSubject): void {
  describe(`Agent API conformance: ${name}`, () => {
    let agent: Agent;
    /** Until the message just sent is running its `hold` or `stubborn` call, so a release or a stop reaches it. */
    const holding = () => vi.waitFor(() => expect(subject.held()).toBe(1), { timeout: 5000, interval: 5 });
    /** Until the abort just sent has recorded its stop. */
    const stopRecorded = (count = 1) =>
      vi.waitFor(() => expect(subject.signalled()).toBe(count), { timeout: 5000, interval: 5 });
    beforeEach(async () => {
      agent = await subject.start();
    });
    afterEach(async () => {
      await subject.stop();
    });

    describe("Invoke", () => {
      it("answers with a receipt once the message is recorded, without waiting for it to be answered", async () => {
        const sessionId = await newSession(agent);
        const receipt = await accepted(agent, { sessionId, content: text("hold") });
        expect(receipt.sessionId).toBe(sessionId);
        expect(receipt.duplicate).toBe(false);
        expect(["queued", "taken"]).toContain(receipt.message.status);
        expect(await statusOf(agent, sessionId, receipt.message.messageId)).toBeDefined();
        let settled = false;
        const waiting = receipt.wait().then((result) => {
          settled = true;
          return result;
        });
        await holding();
        expect(settled).toBe(false);
        subject.release();
        const result = await waiting;
        expect(result).toMatchObject({ ok: true, message: { status: "done", outcome: { status: "completed" } } });
      });

      it("records nothing for a rejection", async () => {
        const sessionId = await newSession(agent);
        const refusals = await Promise.all([
          agent.invoke({ sessionId, content: [] }),
          agent.invoke({ sessionId, content: [{ type: "video" } as unknown as ContentPart] }),
          agent.invoke({ content: text("keyed"), idempotencyKey: "k" }),
          agent.invoke({ sessionId, content: text("keyed"), idempotencyKey: "" }),
        ]);
        for (const refusal of refusals) {
          expect(refusal).toMatchObject({ ok: false, error: { code: "invalid_request", retryable: false } });
        }
        const page = await agent.read(sessionId);
        expect(page).toMatchObject({ ok: true, entries: [], state: { status: "idle", taken: [], queued: [] } });
      });

      it("gives an invoke without sessionId a new session, and refuses an unknown one", async () => {
        const receipt = await accepted(agent, { content: text("hi") });
        expect((await ended(receipt)).answer?.text).toBe("answer: hi");
        expect(await agent.read(receipt.sessionId)).toMatchObject({ ok: true });
        const unknown = await agent.invoke({ sessionId: "no-such-session", content: text("hi") });
        expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
        const messageAsSession = await agent.invoke({ sessionId: receipt.message.messageId, content: text("hi") });
        expect(messageAsSession).toMatchObject({ ok: false, error: { code: "not_found" } });
      });

      it("takes the content types info().inputs lists, and refuses others", async () => {
        expect(agent.info()).toMatchObject({ protocolVersion: "1.0", inputs: expect.arrayContaining(["text"]) });
        const receipt = await accepted(agent, {
          content: [
            { type: "text", text: "look" },
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ],
        });
        await ended(receipt);
        const refused = await agent.invoke({ content: [{ type: "audio" } as unknown as ContentPart] });
        expect(refused).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      });

      it("expands a command for the model while its user_message holds the text as sent", async () => {
        expect(agent.info().commands).toContainEqual({ name: "greet", description: "Greets someone" });
        const sessionId = await newSession(agent);
        const command = await accepted(agent, { sessionId, content: text("/greet Bob") });
        expect((await ended(command)).answer?.text).toBe("answer: hello Bob");
        const unknown = await accepted(agent, { sessionId, content: text("/nope x") });
        expect((await ended(unknown)).answer?.text).toBe("answer: /nope x");
        const users = (await history(agent, sessionId)).filter((entry) => entry.kind === "user_message");
        expect(users.map((entry) => (entry.data as { content: ContentPart[] }).content)).toEqual([
          text("/greet Bob"),
          text("/nope x"),
        ]);
      });

      it("resolves wait() with the message's done, also when it is called after the message ended", async () => {
        const sessionId = await newSession(agent);
        const receipt = await accepted(agent, { sessionId, content: text("hi") });
        const first = await ended(receipt);
        const again = await ended(receipt);
        expect(again).toEqual(first);
        expect(await statusOf(agent, sessionId, receipt.message.messageId)).toEqual(first);
      });

      it("resolves wait() unfinished when its signal is aborted, and the message goes on", async () => {
        const sessionId = await newSession(agent);
        const receipt = await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const controller = new AbortController();
        const waiting = receipt.wait({ signal: controller.signal });
        controller.abort();
        expect(await waiting).toMatchObject({ ok: false, unfinished: { reason: expect.any(String) } });
        expect((await statusOf(agent, sessionId, receipt.message.messageId))?.status).toBe("taken");
        subject.release();
        expect((await ended(receipt)).outcome).toEqual({ status: "completed" });
      });

      it("resolves wait() unfinished, never a rejection, when the storage fails", async () => {
        const sessionId = await newSession(agent);
        const receipt = await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const waiting = receipt.wait();
        subject.failStorage();
        subject.release();
        expect(await waiting).toMatchObject({ ok: false, unfinished: { reason: expect.any(String) } });
      });

      it("gives results and events that are JSON", async () => {
        const sessionId = await newSession(agent);
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        const receipt = await accepted(agent, { sessionId, content: text("hi") });
        const { wait: _wait, ...data } = receipt;
        expect(JSON.parse(JSON.stringify(data))).toEqual(data);
        const events = await watching.until(doneOf(receipt.message.messageId));
        await watching.close();
        expect(JSON.parse(JSON.stringify(events))).toEqual(events);
        const page = await agent.read(sessionId);
        expect(JSON.parse(JSON.stringify(page))).toEqual(page);
      });
    });

    describe("Busy", () => {
      it("takes queued messages in arrival order, with their positions", async () => {
        const sessionId = await newSession(agent);
        const first = await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const queued = [];
        for (const word of ["a", "b", "c"]) queued.push(await accepted(agent, { sessionId, content: text(word) }));
        expect(queued.map((receipt) => receipt.message)).toMatchObject([
          { status: "queued", position: 0 },
          { status: "queued", position: 1 },
          { status: "queued", position: 2 },
        ]);
        subject.release();
        for (const receipt of queued) expect((await ended(receipt)).outcome.status).toBe("completed");
        const order = (await history(agent, sessionId)).flatMap((entry) => userMessageOf(entry) ?? []);
        expect(order).toEqual([first, ...queued].map((receipt) => receipt.message.messageId));
      });

      it("rejects a reject message to a busy session with busy/running, recording nothing", async () => {
        const sessionId = await newSession(agent);
        await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const refused = await agent.invoke({ sessionId, content: text("now"), whenBusy: "reject" });
        expect(refused).toMatchObject({
          ok: false,
          error: { code: "busy", retryable: true, details: { reason: "running" } },
        });
        expect(await agent.read(sessionId, { limit: 0 })).toMatchObject({ ok: true, state: { queued: [] } });
        subject.release();
      });

      it("queues a steer first, and takes it while the session is still busy", async () => {
        const sessionId = await newSession(agent);
        const running = await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const queued = await accepted(agent, { sessionId, content: text("later") });
        const steer = await accepted(agent, { sessionId, content: text("steer"), whenBusy: "steer" });
        expect(steer.message).toMatchObject({ status: "queued", position: 0 });
        expect(await statusOf(agent, sessionId, queued.message.messageId)).toMatchObject({ position: 1 });
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        subject.release();
        const events = await watching.until(doneOf(running.message.messageId));
        await watching.close();
        expect(entriesIn(events).some((entry) => userMessageOf(entry) === steer.message.messageId)).toBe(true);
        await ended(steer);
        await ended(queued);
      });

      it("takes a steer the agent did not take before it stopped no later than the queued messages", async () => {
        const sessionId = await newSession(agent);
        const running = await accepted(agent, { sessionId, content: text("slow") });
        await untilStatus(agent, sessionId, running.message.messageId, "taken");
        const queued = await accepted(agent, { sessionId, content: text("later") });
        const steer = await accepted(agent, { sessionId, content: text("steer"), whenBusy: "steer" });
        await ended(queued);
        await ended(steer);
        const all = await history(agent, sessionId);
        const at = (messageId: string) => all.findIndex((entry) => userMessageOf(entry) === messageId);
        const queuedAnswered = all.findIndex(
          (entry, index) => index > at(queued.message.messageId) && entry.kind === "assistant_message",
        );
        expect(at(steer.message.messageId)).toBeGreaterThan(at(running.message.messageId));
        expect(at(steer.message.messageId)).toBeLessThan(queuedAnswered);
      });

      it("takes a message at once in an idle session, whatever whenBusy says", async () => {
        for (const whenBusy of ["queue", "steer", "reject"] as const) {
          const receipt = await accepted(agent, { content: text("hi"), whenBusy });
          expect(receipt.message.status).not.toBe("queued");
          expect((await ended(receipt)).outcome.status).toBe("completed");
        }
      });

      it("refuses the 21st queued message with busy/queue_full", async () => {
        const sessionId = await newSession(agent);
        await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        for (let i = 0; i < 20; i++) await accepted(agent, { sessionId, content: text(`q${i}`) });
        const refused = await agent.invoke({ sessionId, content: text("one too many") });
        expect(refused).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "queue_full" } } });
        subject.release();
      });

      it("refuses a message past the process's capacity with busy/capacity", async () => {
        agent = await subject.start({ inFlightPerProcess: 2 });
        await accepted(agent, { content: text("hold") });
        await accepted(agent, { content: text("hold") });
        const refused = await agent.invoke({ content: text("hi") });
        expect(refused).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "capacity" } } });
        subject.release();
      });
    });

    describe("Idempotency", () => {
      it("returns a key's message while it is queued, taken and done, recording it once", async () => {
        const sessionId = await newSession(agent);
        const running = await accepted(agent, { sessionId, content: text("hold"), idempotencyKey: "first" });
        await holding();
        const queued = await accepted(agent, { sessionId, content: text("hi"), idempotencyKey: "second" });
        const whileQueued = await accepted(agent, { sessionId, content: text("other"), idempotencyKey: "second" });
        expect(whileQueued).toMatchObject({
          duplicate: true,
          message: { messageId: queued.message.messageId, status: "queued" },
        });
        const whileTaken = await accepted(agent, { sessionId, content: text("hold"), idempotencyKey: "first" });
        expect(whileTaken).toMatchObject({
          duplicate: true,
          message: { messageId: running.message.messageId, status: "taken" },
        });
        subject.release();
        const end = await ended(queued);
        const whenDone = await accepted(agent, { sessionId, content: text("hi"), idempotencyKey: "second" });
        expect(whenDone).toMatchObject({ duplicate: true, message: end });
        expect(await ended(whenDone)).toEqual(end);
        expect(await ended(whileQueued)).toEqual(end);
        const users = (await history(agent, sessionId)).filter((entry) => entry.kind === "user_message");
        expect(users.map((entry) => (entry.data as { idempotencyKey?: string }).idempotencyKey)).toEqual([
          "first",
          "second",
        ]);
      });

      it("makes one message of concurrent invokes with one key", async () => {
        const sessionId = await newSession(agent);
        const receipts = await Promise.all(
          Array.from({ length: 5 }, () => accepted(agent, { sessionId, content: text("hi"), idempotencyKey: "once" })),
        );
        expect(new Set(receipts.map((receipt) => receipt.message.messageId)).size).toBe(1);
        expect(receipts.filter((receipt) => !receipt.duplicate)).toHaveLength(1);
        await ended(receipts[0] as Receipt);
        expect((await history(agent, sessionId)).filter((entry) => entry.kind === "user_message")).toHaveLength(1);
      });
    });

    describe("Messages", () => {
      it("follows a message through queued, taken and done by its id and by its key", async () => {
        const sessionId = await newSession(agent);
        const running = await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const receipt = await accepted(agent, { sessionId, content: text("hi"), idempotencyKey: "tracked" });
        const byKey = () => agent.getMessage(sessionId, { idempotencyKey: "tracked" });
        expect(await byKey()).toMatchObject({ messageId: receipt.message.messageId, status: "queued", position: 0 });
        expect((await statusOf(agent, sessionId, running.message.messageId))?.status).toBe("taken");
        subject.release();
        const end = await ended(receipt);
        expect(await byKey()).toEqual(end);
        expect(end).toMatchObject({ idempotencyKey: "tracked", outcome: { status: "completed" } });
        expect(await agent.getMessage(sessionId, { messageId: "no-such-message" })).toBeUndefined();
        expect(await agent.getMessage(sessionId, { idempotencyKey: "never-sent" })).toBeUndefined();
        expect(await agent.getMessage("no-such-session", { messageId: receipt.message.messageId })).toBeUndefined();
        const other = await newSession(agent);
        expect(await agent.getMessage(other, { messageId: receipt.message.messageId })).toBeUndefined();
      });

      it("ends a message whose Caller never waits or watches", async () => {
        const receipt = await accepted(agent, { content: text("hi") });
        await untilStatus(agent, receipt.sessionId, receipt.message.messageId, "done");
      });

      it("stops the taken message and withdraws the queued ones, answering once they ended canceled", async () => {
        const sessionId = await newSession(agent);
        expect(await agent.abort(sessionId)).toEqual({ ok: true, stopped: { taken: [], queued: [] } });
        const running = await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const queued = await accepted(agent, { sessionId, content: text("hi") });
        const result = await agent.abort(sessionId);
        expect(result).toEqual({
          ok: true,
          stopped: { taken: [running.message.messageId], queued: [queued.message.messageId] },
        });
        for (const receipt of [running, queued]) {
          const status = await statusOf(agent, sessionId, receipt.message.messageId);
          expect(status).toMatchObject({ status: "done", outcome: { status: "canceled" } });
          expect(status).not.toHaveProperty("answer");
        }
        expect(await statusOf(agent, sessionId, queued.message.messageId)).not.toHaveProperty("entryId");
        expect(await agent.abort("no-such-session")).toMatchObject({ ok: false, error: { code: "not_found" } });
      });

      it("reports the same message from a second abort while a tool ignoring its signal keeps the first waiting", async () => {
        const sessionId = await newSession(agent);
        const running = await accepted(agent, { sessionId, content: text("stubborn") });
        await holding();
        const first = agent.abort(sessionId);
        await stopRecorded();
        const second = agent.abort(sessionId);
        // The second abort reads which messages it stops before the tool is let go.
        await new Promise((resolve) => setTimeout(resolve, 50));
        subject.release();
        const stopped = { ok: true, stopped: { taken: [running.message.messageId], queued: [] } };
        expect(await first).toEqual(stopped);
        expect(await second).toEqual(stopped);
        expect(await statusOf(agent, sessionId, running.message.messageId)).toMatchObject({
          outcome: { status: "canceled" },
        });
      });

      it("answers unknown for an abort whose signal is aborted, and its stop still ends the message canceled", async () => {
        const sessionId = await newSession(agent);
        const running = await accepted(agent, { sessionId, content: text("stubborn") });
        await holding();
        const controller = new AbortController();
        const stopping = agent.abort(sessionId, { signal: controller.signal });
        await stopRecorded();
        controller.abort();
        expect(await stopping).toMatchObject({ ok: false, unknown: { reason: expect.any(String) } });
        subject.release();
        await untilStatus(agent, sessionId, running.message.messageId, "done");
        expect(await statusOf(agent, sessionId, running.message.messageId)).toMatchObject({
          outcome: { status: "canceled" },
        });
      });

      it("takes the messages invoked after a failed one", async () => {
        const sessionId = await newSession(agent);
        await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const failing = await accepted(agent, { sessionId, content: text("fail") });
        const after = await accepted(agent, { sessionId, content: text("after") });
        subject.release();
        expect((await ended(failing)).outcome).toMatchObject({ status: "failed", error: { code: "model_error" } });
        expect((await ended(after)).outcome).toEqual({ status: "completed" });
      });

      it("takes a message invoked while an abort is still ending the messages it stopped", async () => {
        for (const signalled of [false, true]) {
          const sessionId = await newSession(agent);
          await accepted(agent, { sessionId, content: text("stubborn") });
          await holding();
          const controller = new AbortController();
          const stopping = agent.abort(sessionId, { signal: controller.signal });
          await stopRecorded(signalled ? 2 : 1);
          const next = await accepted(agent, { sessionId, content: text("next") });
          if (signalled) controller.abort();
          subject.release();
          await stopping;
          expect((await ended(next)).outcome).toEqual({ status: "completed" });
        }
      });

      it("gives an answer only to a completed or max_tokens message, never a reply whose tool calls ran", async () => {
        const sessionId = await newSession(agent);
        const completed = await ended(await accepted(agent, { sessionId, content: text("hi") }));
        expect(completed).toMatchObject({ outcome: { status: "completed" }, answer: { text: "answer: hi" } });
        const cut = await ended(await accepted(agent, { sessionId, content: text("long") }));
        expect(cut).toMatchObject({ outcome: { status: "max_tokens" }, answer: { text: "cut short" } });
        const failed = await ended(await accepted(agent, { sessionId, content: text("fail") }));
        expect(failed.outcome.status).toBe("failed");
        expect(failed).not.toHaveProperty("answer");
        const finished = await ended(await accepted(agent, { sessionId, content: text("finish") }));
        expect(finished.outcome).toEqual({ status: "completed" });
        expect(finished).not.toHaveProperty("answer");
        const tool = await ended(await accepted(agent, { sessionId, content: text("effect") }));
        expect(tool.answer?.text).toBe("answer: effect");
      });

      it("ends a message failed with auth_required when its model provider has no credential", async () => {
        agent = await subject.start({ signedOut: true });
        const end = await ended(await accepted(agent, { content: text("hi") }));
        expect(end.outcome).toMatchObject({ status: "failed", error: { code: "auth_required", retryable: false } });
        expect(end).not.toHaveProperty("answer");
      });
    });

    describe("Restart", () => {
      it("answers a message accepted just before a restart after it, and getMessage finds it", async () => {
        const sessionId = await newSession(agent);
        const receipt = await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        agent = await subject.restart();
        expect(await statusOf(agent, sessionId, receipt.message.messageId)).toBeDefined();
        await untilStatus(agent, sessionId, receipt.message.messageId, "done");
        expect(await statusOf(agent, sessionId, receipt.message.messageId)).toMatchObject({
          outcome: { status: "completed" },
        });
      });

      it("keeps the queued messages, and takes them", async () => {
        const sessionId = await newSession(agent);
        await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const queued = [
          await accepted(agent, { sessionId, content: text("a") }),
          await accepted(agent, { sessionId, content: text("b") }),
        ];
        agent = await subject.restart();
        for (const receipt of queued) {
          await untilStatus(agent, sessionId, receipt.message.messageId, "done");
          expect(await statusOf(agent, sessionId, receipt.message.messageId)).toMatchObject({
            outcome: { status: "completed" },
          });
        }
      });

      it("ends a message an abort was stopping when the process stopped canceled after the restart", async () => {
        const sessionId = await newSession(agent);
        const running = await accepted(agent, { sessionId, content: text("stubborn") });
        await holding();
        void agent.abort(sessionId);
        await stopRecorded();
        agent = await subject.restart();
        await untilStatus(agent, sessionId, running.message.messageId, "done");
        const status = await statusOf(agent, sessionId, running.message.messageId);
        expect(status).toMatchObject({ outcome: { status: "canceled" } });
        expect(status).not.toHaveProperty("answer");
      });

      it("does not redo a tool call the process stopped after its effect", async () => {
        const sessionId = await newSession(agent);
        const receipt = await accepted(agent, { sessionId, content: text("mark") });
        await holding();
        expect(subject.effects()).toBe(1);
        agent = await subject.restart();
        await untilStatus(agent, sessionId, receipt.message.messageId, "done");
        expect(await statusOf(agent, sessionId, receipt.message.messageId)).toMatchObject({
          outcome: { status: "completed" },
        });
        expect(subject.effects()).toBe(1);
      });
    });

    describe("Resuming", () => {
      it("replays nothing without replayFrom, every entry from start, and the entries after a cursor", async () => {
        const sessionId = await newSession(agent);
        await ended(await accepted(agent, { sessionId, content: text("one") }));
        await ended(await accepted(agent, { sessionId, content: text("two") }));
        const all = await history(agent, sessionId);
        expect(all).toHaveLength(4);

        const none = attach(agent, sessionId);
        expect(await none.until(isState)).toMatchObject([{ type: "state", state: { status: "idle" } }]);
        await none.close();

        const fromStart = attach(agent, sessionId, { replayFrom: { type: "start" } });
        const replayed = await fromStart.until(isState);
        await fromStart.close();
        expect(entriesIn(replayed)).toEqual(all);
        expect(replayed.at(-1)?.type).toBe("state");

        const fromCursor = attach(agent, sessionId, { replayFrom: { type: "after", entryId: (all[1] as Entry).id } });
        const rest = await fromCursor.until(isState);
        await fromCursor.close();
        expect(entriesIn(rest)).toEqual(all.slice(2));
      });

      it("delivers a message invoked after the resume opened, from its user_message to its done", async () => {
        const sessionId = await newSession(agent);
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        const receipt = await accepted(agent, { sessionId, content: text("hi") });
        const events = await watching.until(doneOf(receipt.message.messageId));
        await watching.close();
        const entries = entriesIn(events);
        expect(entries.map((entry) => entry.kind)).toEqual(["user_message", "assistant_message"]);
        expect(userMessageOf(entries[0] as Entry)).toBe(receipt.message.messageId);
        expect(events.at(-1)).toEqual({ type: "done", message: await ended(receipt) });
      });

      it("sends a message's done before the user_message of the message taken after it", async () => {
        const sessionId = await newSession(agent);
        const running = await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const queued = await accepted(agent, { sessionId, content: text("next") });
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        subject.release();
        const events = await watching.until(doneOf(queued.message.messageId));
        await watching.close();
        const doneAt = events.findIndex(doneOf(running.message.messageId));
        const takenAt = events.findIndex(
          (event) => event.type === "entry" && userMessageOf(event.entry) === queued.message.messageId,
        );
        expect(doneAt).toBeGreaterThanOrEqual(0);
        expect(doneAt).toBeLessThan(takenAt);
        expect(events.filter((event) => event.type === "state")).toHaveLength(0);
      });

      it("gives a Caller attached mid-answer the reply so far, which the deltas continue", async () => {
        const sessionId = await newSession(agent);
        const receipt = await accepted(agent, { sessionId, content: text("slow") });
        await vi.waitFor(
          async () => {
            const page = await agent.read(sessionId, { limit: 0 });
            expect(page.ok && page.state.reply?.text).toBeTruthy();
          },
          { timeout: 5000, interval: 10 },
        );
        const watching = attach(agent, sessionId);
        const [state] = await watching.until(isState);
        const events = await watching.until(doneOf(receipt.message.messageId));
        await watching.close();
        const shown = state?.type === "state" ? (state.state.reply?.text ?? "") : "";
        const deltas = events.flatMap((event) =>
          event.type === "message_delta" && event.channel === "text" ? [event.delta] : [],
        );
        const answer = entriesIn(events).find((entry) => entry.kind === "assistant_message") as Entry;
        expect(shown).not.toBe("");
        expect(deltas.length).toBeGreaterThan(0);
        expect((answer.data as { text: string }).text.startsWith(shown + deltas.join(""))).toBe(true);
      });

      it("delivers a running tool's start and its status lines, a nested call as its caller's", async () => {
        const sessionId = await newSession(agent);
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        const streamed = await accepted(agent, { sessionId, content: text("stream") });
        const events = await watching.until(doneOf(streamed.message.messageId));
        const nested = await accepted(agent, { sessionId, content: text("nested") });
        const more = await watching.until(doneOf(nested.message.messageId));
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
        expect(events.indexOf(started as ResumeEvent)).toBeLessThan(result);
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

      it("explains a quiet gap with retry_scheduled before the attempt that answers", async () => {
        const sessionId = await newSession(agent);
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        const receipt = await accepted(agent, { sessionId, content: text("flaky") });
        const events = await watching.until(doneOf(receipt.message.messageId));
        await watching.close();
        const retry = events.findIndex((event) => event.type === "retry_scheduled");
        expect(events[retry]).toMatchObject({
          type: "retry_scheduled",
          attempt: 1,
          maxAttempts: expect.any(Number),
          delayMs: expect.any(Number),
          reason: expect.stringContaining("overloaded"),
        });
        const answer = events.findIndex(
          (event) =>
            event.type === "entry" &&
            event.entry.kind === "assistant_message" &&
            (event.entry.data as { outcome?: unknown }).outcome === undefined,
        );
        expect(retry).toBeLessThan(answer);
        expect(events.at(-1)).toMatchObject({ type: "done", message: { outcome: { status: "completed" } } });
      });

      it("streams the model's thinking on its own channel, never folded into the answer", async () => {
        const sessionId = await newSession(agent);
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        const receipt = await accepted(agent, { sessionId, content: text("ponder") });
        const events = await watching.until(doneOf(receipt.message.messageId));
        await watching.close();
        const deltas = (channel: "text" | "thinking") =>
          events.flatMap((event) => (event.type === "message_delta" && event.channel === channel ? [event.delta] : []));
        const reply = entriesIn(events).find((entry) => entry.kind === "assistant_message") as Entry;
        const data = reply.data as { text: string; thinking?: string };
        expect(deltas("thinking").length).toBeGreaterThan(0);
        expect(data.thinking?.startsWith(deltas("thinking").join(""))).toBe(true);
        expect(data.text).toBe("answer: ponder");
        expect(data.text.startsWith(deltas("text").join(""))).toBe(true);
      });

      it("delivers each entry exactly once across a reconnect after the last entry it had", async () => {
        const sessionId = await newSession(agent);
        await ended(await accepted(agent, { sessionId, content: text("one") }));
        const first = attach(agent, sessionId, { replayFrom: { type: "start" } });
        const had = entriesIn(await first.until(isState));
        await first.close();
        await ended(await accepted(agent, { sessionId, content: text("two") }));
        const second = attach(agent, sessionId, { replayFrom: { type: "after", entryId: (had.at(-1) as Entry).id } });
        const more = entriesIn(await second.until(isState));
        await second.close();
        expect([...had, ...more]).toEqual(await history(agent, sessionId));
      });

      it("ends with serving_error when the storage fails", async () => {
        const sessionId = await newSession(agent);
        await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const watching = attach(agent, sessionId);
        await watching.until(isState);
        subject.failStorage();
        subject.release();
        const rest = await watching.rest();
        expect(rest.at(-1)).toMatchObject({ type: "serving_error", error: { code: "unavailable" } });
      });

      it("rejects an unknown session or cursor with a single rejected", async () => {
        const unknown = await attach(agent, "no-such-session").rest();
        expect(unknown).toEqual([{ type: "rejected", error: expect.objectContaining({ code: "not_found" }) }]);
        const sessionId = await newSession(agent);
        const cursor = await attach(agent, sessionId, { replayFrom: { type: "after", entryId: "nope" } }).rest();
        expect(cursor).toEqual([{ type: "rejected", error: expect.objectContaining({ code: "not_found" }) }]);
      });
    });

    describe("Reading", () => {
      it("pages by after, before and limit, the newest page first, and gives the state alone for limit 0", async () => {
        const sessionId = await newSession(agent);
        for (const word of ["one", "two", "three"])
          await ended(await accepted(agent, { sessionId, content: text(word) }));
        const all = await history(agent, sessionId);
        expect(all).toHaveLength(6);
        expect(all.slice(1).map((entry) => entry.parentEntryId)).toEqual(all.slice(0, -1).map((entry) => entry.id));
        expect(all[0]).not.toHaveProperty("parentEntryId");

        const newest = await agent.read(sessionId, { limit: 2 });
        expect(newest).toMatchObject({ ok: true, entries: all.slice(4), prev: all[4]?.id });
        expect(newest).not.toHaveProperty("next");
        const older = await agent.read(sessionId, { before: all[4]?.id, limit: 2 });
        expect(older).toMatchObject({ ok: true, entries: all.slice(2, 4), prev: all[2]?.id, next: all[3]?.id });
        const oldest = await agent.read(sessionId, { before: all[2]?.id, limit: 5 });
        expect(oldest).toMatchObject({ ok: true, entries: all.slice(0, 2), next: all[1]?.id });
        expect(oldest).not.toHaveProperty("prev");
        const after = await agent.read(sessionId, { after: all[1]?.id, limit: 2 });
        expect(after).toMatchObject({ ok: true, entries: all.slice(2, 4), prev: all[2]?.id, next: all[3]?.id });

        expect(await agent.read(sessionId, { limit: 0 })).toEqual({
          ok: true,
          state: { status: "idle", taken: [], queued: [], usage: expect.any(Object) },
          entries: [],
        });
        expect(await agent.read(sessionId, { limit: 501 })).toMatchObject({
          ok: false,
          error: { code: "invalid_request" },
        });
        expect(await agent.read(sessionId, { after: "nope" })).toMatchObject({
          ok: false,
          error: { code: "not_found" },
        });
        expect(await agent.read("no-such-session")).toMatchObject({ ok: false, error: { code: "not_found" } });
      });

      it("names a taken message in its user_message, and gives every assistant_message its usage", async () => {
        const sessionId = await newSession(agent);
        const receipt = await accepted(agent, { sessionId, content: text("effect"), idempotencyKey: "named" });
        await ended(receipt);
        const all = await history(agent, sessionId);
        expect(all[0]).toMatchObject({
          kind: "user_message",
          sessionId,
          data: { content: text("effect"), messageId: receipt.message.messageId, idempotencyKey: "named" },
        });
        const replies = all.filter((entry) => entry.kind === "assistant_message");
        expect(replies).toHaveLength(2);
        for (const reply of replies) {
          expect(reply.data).toMatchObject({
            usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
          });
        }
        expect(all.map((entry) => entry.kind)).toEqual([
          "user_message",
          "assistant_message",
          "tool_result",
          "assistant_message",
        ]);
      });

      it("counts a session's own spend in its state, a fork's from nothing", async () => {
        const sessionId = await newSession(agent);
        const empty = { models: {}, tools: {} };
        expect(await agent.read(sessionId, { limit: 0 })).toMatchObject({ state: { usage: empty } });
        await ended(await accepted(agent, { sessionId, content: text("hi") }));
        const spent = await agent.read(sessionId, { limit: 0 });
        if (!spent.ok) throw new Error(JSON.stringify(spent));
        const calls = Object.values(spent.state.usage.models);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.outputTokens).toBeGreaterThan(0);
        const reply = (await history(agent, sessionId)).find((entry) => entry.kind === "assistant_message") as Entry;
        expect(calls[0]).toMatchObject((reply.data as { usage: object }).usage);
        const fork = await agent.createSession({ from: { sessionId } });
        if (!fork.ok) throw new Error(JSON.stringify(fork));
        expect(await agent.read(fork.sessionId, { limit: 0 })).toMatchObject({ state: { usage: empty } });
        const watching = attach(agent, sessionId);
        const [state] = await watching.until(isState);
        await watching.close();
        expect(state).toMatchObject({ type: "state", state: { usage: spent.state.usage } });
      });

      it("moves the state from idle to running and back", async () => {
        const sessionId = await newSession(agent);
        expect(await agent.read(sessionId, { limit: 0 })).toMatchObject({ state: { status: "idle" } });
        const running = await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        expect(await agent.read(sessionId, { limit: 0 })).toMatchObject({
          state: { status: "running", taken: [running.message.messageId], queued: [] },
        });
        subject.release();
        await ended(running);
        expect(await agent.read(sessionId, { limit: 0 })).toMatchObject({ state: { status: "idle", taken: [] } });
      });

      it("returns an image a message carried through its ref", async () => {
        const sessionId = await newSession(agent);
        const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } as const;
        await ended(await accepted(agent, { sessionId, content: [{ type: "text", text: "look" }, image] }));
        const [user] = await history(agent, sessionId);
        const part = ((user as Entry).data as { content: ContentPart[] }).content[1];
        expect(part).toMatchObject({ type: "image", mimeType: "image/png", ref: expect.any(String) });
        const ref = (part as { ref: string }).ref;
        expect(await agent.attachment(sessionId, ref)).toEqual({ mimeType: "image/png", data: image.data });
        expect(await agent.attachment(sessionId, "nope")).toBeUndefined();
        expect(await agent.attachment(await newSession(agent), ref)).toBeUndefined();
      });
    });

    describe("stream()", () => {
      type Streamed = Extract<StreamResult, { ok: true }>;
      const streamed = async (target: Agent, request: InvokeRequest & { sessionId: string }) => {
        const result = await stream(target, request);
        if (!result.ok) throw new Error(`stream() was not accepted: ${JSON.stringify(result)}`);
        return result;
      };
      const drain = async ({ events }: Streamed) => {
        const out: ResumeEvent[] = [];
        for await (const event of events) out.push(event);
        return out;
      };
      const replies = (events: ResumeEvent[]) =>
        entriesIn(events).map((entry) => `${entry.kind}:${(entry.data as { text?: string }).text ?? ""}`);

      it("delivers a new message's events after its user_message, through its done", async () => {
        const sessionId = await newSession(agent);
        const result = await streamed(agent, { sessionId, content: text("hi") });
        expect(result).toMatchObject({ sessionId, duplicate: false });
        const events = await drain(result);
        expect(replies(events)).toEqual(["assistant_message:answer: hi"]);
        expect(events.at(-1)).toEqual({
          type: "done",
          message: await getDone(agent, sessionId, result.message.messageId),
        });
      });

      it("delivers only its own message's events for a message queued behind another", async () => {
        const sessionId = await newSession(agent);
        await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const result = await streamed(agent, { sessionId, content: text("next") });
        expect(result.message).toMatchObject({ status: "queued", position: 0 });
        subject.release();
        const events = await drain(result);
        expect(replies(events)).toEqual(["assistant_message:answer: next"]);
        expect(events.at(-1)).toMatchObject({ type: "done", message: { outcome: { status: "completed" } } });
      });

      it("delivers a queued duplicate's events once it is taken", async () => {
        const sessionId = await newSession(agent);
        await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        const first = await accepted(agent, { sessionId, content: text("next"), idempotencyKey: "k" });
        const result = await streamed(agent, { sessionId, content: text("next"), idempotencyKey: "k" });
        expect(result).toMatchObject({
          duplicate: true,
          message: { messageId: first.message.messageId, status: "queued" },
        });
        subject.release();
        expect(replies(await drain(result))).toEqual(["assistant_message:answer: next"]);
      });

      it("delivers a taken duplicate's events from its user_message on, what it already wrote included", async () => {
        const sessionId = await newSession(agent);
        await accepted(agent, { sessionId, content: text("hold"), idempotencyKey: "k" });
        await holding();
        const result = await streamed(agent, { sessionId, content: text("hold"), idempotencyKey: "k" });
        expect(result).toMatchObject({ duplicate: true, message: { status: "taken" } });
        subject.release();
        const events = await drain(result);
        expect(replies(events)).toEqual(["assistant_message:", "tool_result:", "assistant_message:answer: hold"]);
        expect(events.at(-1)).toMatchObject({ type: "done", message: { answer: { text: "answer: hold" } } });
      });

      it("stops a taken duplicate at its answer when it ended before the stream reattached", async () => {
        const sessionId = await newSession(agent);
        const held = await accepted(agent, { sessionId, content: text("hold"), idempotencyKey: "k" });
        await holding();
        const next = await accepted(agent, { sessionId, content: text("next") });
        // The message ends, and the next one is answered, between the receipt and the stream's second resume.
        const late: Agent = {
          ...agent,
          resume: (id, options) =>
            options?.replayFrom === undefined
              ? agent.resume(id, options)
              : {
                  async *[Symbol.asyncIterator]() {
                    subject.release();
                    await untilStatus(agent, sessionId, held.message.messageId, "done");
                    await untilStatus(agent, sessionId, next.message.messageId, "done");
                    yield* agent.resume(id, options);
                  },
                },
        };
        const result = await streamed(late, { sessionId, content: text("hold"), idempotencyKey: "k" });
        const events = await drain(result);
        expect(replies(events)).toEqual(["assistant_message:", "tool_result:", "assistant_message:answer: hold"]);
        expect(events.at(-1)).toMatchObject({ type: "done", message: { messageId: held.message.messageId } });
      });

      it("delivers a done duplicate's entries through its answer, then its done", async () => {
        const sessionId = await newSession(agent);
        await ended(await accepted(agent, { sessionId, content: text("effect"), idempotencyKey: "k" }));
        await ended(await accepted(agent, { sessionId, content: text("after") }));
        const result = await streamed(agent, { sessionId, content: text("effect"), idempotencyKey: "k" });
        expect(result).toMatchObject({ duplicate: true, message: { status: "done" } });
        const events = await drain(result);
        expect(replies(events)).toEqual(["assistant_message:", "tool_result:", "assistant_message:answer: effect"]);
        expect(events.at(-1)).toEqual({ type: "done", message: result.message });
        await ended(await accepted(agent, { sessionId, content: text("fail"), idempotencyKey: "failed" }));
        const failed = await streamed(agent, { sessionId, content: text("fail"), idempotencyKey: "failed" });
        expect(await drain(failed)).toEqual([{ type: "done", message: failed.message }]);
      });

      it("ends with the message's canceled done when it is aborted", async () => {
        const sessionId = await newSession(agent);
        const result = await streamed(agent, { sessionId, content: text("hold") });
        await holding();
        const events = drain(result);
        expect(await agent.abort(sessionId)).toMatchObject({ ok: true });
        expect((await events).at(-1)).toMatchObject({ type: "done", message: { outcome: { status: "canceled" } } });
      });

      it("answers the invoke's refusal, and an unknown session's, recording nothing", async () => {
        expect(await stream(agent, { sessionId: "no-such-session", content: text("hi") })).toMatchObject({
          ok: false,
          error: { code: "not_found" },
        });
        const sessionId = await newSession(agent);
        await accepted(agent, { sessionId, content: text("hold") });
        await holding();
        expect(await stream(agent, { sessionId, content: text("now"), whenBusy: "reject" })).toMatchObject({
          ok: false,
          error: { code: "busy" },
        });
        expect(await agent.read(sessionId, { limit: 0 })).toMatchObject({ state: { queued: [] } });
        subject.release();
      });
    });

    describe("Sessions", () => {
      it("forks the history up to an entry and none of the messages, leaving the source unchanged", async () => {
        const sessionId = await newSession(agent);
        const first = await accepted(agent, { sessionId, content: text("one") });
        await ended(first);
        await ended(await accepted(agent, { sessionId, content: text("two") }));
        const source = await history(agent, sessionId);
        const fork = await agent.createSession({ from: { sessionId, entryId: (source[1] as Entry).id } });
        if (!fork.ok) throw new Error(JSON.stringify(fork));
        expect(await history(agent, fork.sessionId)).toEqual(source.slice(0, 2));
        expect(await agent.getMessage(fork.sessionId, { messageId: first.message.messageId })).toBeUndefined();
        const own = await accepted(agent, { sessionId: fork.sessionId, content: text("three") });
        expect((await ended(own)).answer?.text).toBe("answer: three");
        const forked = await history(agent, fork.sessionId);
        expect(forked.slice(0, 2)).toEqual(source.slice(0, 2));
        expect(forked.slice(2).map((entry) => entry.sessionId)).toEqual([fork.sessionId, fork.sessionId]);
        expect(forked[2]?.parentEntryId).toBe(source[1]?.id);
        expect(await history(agent, sessionId)).toEqual(source);

        const whole = await agent.createSession({ from: { sessionId } });
        if (!whole.ok) throw new Error(JSON.stringify(whole));
        expect(await history(agent, whole.sessionId)).toEqual(source);
      });

      it("refuses a fork of an unknown session or entry with not_found", async () => {
        expect(await agent.createSession({ from: { sessionId: "nope" } })).toMatchObject({
          ok: false,
          error: { code: "not_found" },
        });
        const sessionId = await newSession(agent);
        expect(await agent.createSession({ from: { sessionId, entryId: "nope" } })).toMatchObject({
          ok: false,
          error: { code: "not_found" },
        });
      });
    });
  });
}
