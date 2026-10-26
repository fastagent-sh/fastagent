/** A channel's turn as one message: what it asks the agent, and how its stream is owned. */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, ResumeEvent } from "../src/agent-api.ts";
import { eventStream } from "../src/channels/kit/event-stream.ts";
import { type TurnEvent, attachedFilesManifest, turnStream } from "../src/channels/kit/invoke-turn-kit.ts";
import { PortFailure } from "../src/effect-port.ts";
import { log } from "../src/log.ts";
import { run as runEffect } from "./channel-effects.ts";
import { scriptedAgent } from "./scripted-agent.ts";
import { ev } from "./scripted-run.ts";

afterEach(() => vi.restoreAllMocks());

const ok: TurnEvent[] = [ev.accepted(), ev.text("answer"), ev.ended()];

const turn = (agent: Agent, resolve = async () => {}, session = async () => "s") =>
  turnStream({
    agent,
    label: "[test]",
    session,
    resolve,
    turn: () => ({ idempotencyKey: "msg-1", content: [{ type: "text", text: "hi" }] }),
    retryableLoadFailure: () => false,
  });

const read = (events: Stream.Stream<TurnEvent, PortFailure>) => runEffect(Stream.runCollect(events));

/** A consumer that fails on the turn's end — the shape of a channel whose delivery throws at the answer. */
const failOnEnd = (events: Stream.Stream<TurnEvent, PortFailure>, error: Error) =>
  events.pipe(
    Stream.tap((event) =>
      Effect.try({
        try: () => {
          if (event.type === "done") throw error;
        },
        catch: (cause) => new PortFailure(cause),
      }),
    ),
  );

const snapshot: ResumeEvent = {
  type: "state",
  state: { status: "idle", taken: [], queued: [], usage: { models: {}, tools: {} } },
};
const ownEntry: ResumeEvent = {
  type: "entry",
  entry: { id: "e0", sessionId: "s", timestamp: 0, kind: "user_message", data: { text: "hi", messageId: "message" } },
};

/** An agent whose session events are `source`'s, for a test that watches how the turn pulls and closes them. */
const agentOver = (source: AsyncIterator<ResumeEvent>) =>
  ({
    invoke: async () => ({
      ok: true,
      sessionId: "s",
      message: { messageId: "message", status: "queued", position: 0 },
      duplicate: false,
      wait: async () => ({ ok: false, unfinished: { reason: "not in this double" } }),
    }),
    resume: () => ({ [Symbol.asyncIterator]: () => source }),
  }) as unknown as Agent;

it("asks once, queued behind whatever runs in the session, under the turn's key", async () => {
  const agent = scriptedAgent(() => ok);
  const events = await read(turn(agent));
  expect(events.map((event) => event.type)).toEqual(["accepted", "message_delta", "done"]);
  expect(events[0]).toMatchObject(ok[0] as object);
  expect(agent.sent).toEqual([
    { sessionId: "s", idempotencyKey: "msg-1", content: [{ type: "text", text: "hi" }], whenBusy: "queue" },
  ]);
});

it("a preparation that fails is the turn's refusal, carrying the channel's verdict on a redelivery", async () => {
  const agent = scriptedAgent(() => ok);
  const session = vi.fn(async () => "s");
  const events = await read(
    turn(
      agent,
      async () => {
        throw new Error("the attachment is gone");
      },
      session,
    ),
  );
  expect(events).toMatchObject([
    {
      type: "rejected",
      error: { message: "could not prepare the turn: Error: the attachment is gone", retryable: false },
    },
  ]);
  // Nothing was asked, and no session was made for it.
  expect(session).not.toHaveBeenCalled();
  expect(agent.sent).toEqual([]);
});

it("enters its session while the turn runs and leaves it after, whether the turn succeeds or fails", async () => {
  const entered: string[] = [];
  const left: string[] = [];
  const turnIn = (agent: Agent) =>
    turnStream({
      agent,
      label: "[test]",
      session: async () => "s",
      enter: (sessionId) => {
        entered.push(sessionId);
        return () => left.push(sessionId);
      },
      resolve: async () => {},
      turn: () => ({ idempotencyKey: "msg-1", content: [{ type: "text", text: "hi" }] }),
      retryableLoadFailure: () => false,
    });
  const during = (events: Stream.Stream<TurnEvent, PortFailure>) =>
    events.pipe(Stream.tap(() => Effect.sync(() => expect(left).toEqual([]))));
  await read(during(turnIn(scriptedAgent(() => ok))));
  expect([entered, left]).toEqual([["s"], ["s"]]);
  await expect(read(failOnEnd(turnIn(scriptedAgent(() => ok)), new Error("broke")))).rejects.toThrow("broke");
  expect([entered, left]).toEqual([
    ["s", "s"],
    ["s", "s"],
  ]);
});

it("a refusal and an unknown receipt are each the turn's one event", async () => {
  expect(await read(turn(scriptedAgent(() => [ev.rejected("busy")])))).toMatchObject([
    { type: "rejected", error: { code: "busy" } },
  ]);
  expect(await read(turn(scriptedAgent(() => [ev.unknown("the disk is gone")])))).toEqual([
    { type: "unknown", reason: "the disk is gone" },
  ]);
});

it("keeps the session's events behind consumer demand, and closes them when the turn's scope ends", async () => {
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const next = vi
    .fn()
    .mockResolvedValueOnce({ done: false, value: snapshot })
    .mockResolvedValueOnce({ done: false, value: ownEntry })
    .mockResolvedValueOnce({ done: false, value: ok[1] });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(turn(agentOver({ next, return: close })));
        expect(next).not.toHaveBeenCalled();
        expect(yield* pull).toMatchObject([{ type: "accepted" }]);
        expect(next).toHaveBeenCalledTimes(1);
        expect(yield* pull).toEqual([ok[1]]);
        expect(next).toHaveBeenCalledTimes(3);
        expect(close).not.toHaveBeenCalled();
      }),
    ),
  );
  expect(close).toHaveBeenCalledTimes(1);
});

it("a consumer failure at the end keeps its identity and closes the session's events", async () => {
  const error = new Error("handing the answer over failed");
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const events = [snapshot, ownEntry, ok[1], ok[2]] as ResumeEvent[];
  const next = vi.fn(async () => {
    const value = events.shift();
    return value === undefined ? new Promise<never>(() => {}) : { done: false as const, value };
  });
  await expect(read(failOnEnd(turn(agentOver({ next, return: close })), error))).rejects.toBe(error);
  expect(close).toHaveBeenCalledTimes(1);
});

describe("eventStream: an Agent's iterable owned by a channel stream", () => {
  const read = <A>(open: () => AsyncIterable<A>) => runEffect(Stream.runCollect(eventStream(open, "[test]")));

  it("preserves natural exhaustion without calling return on an already-closed source", async () => {
    const close = vi.fn(async () => {
      throw new Error("source was already closed");
    });
    const next = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: ok[2] })
      .mockResolvedValueOnce({ done: true, value: undefined });
    expect(await read(() => ({ [Symbol.asyncIterator]: () => ({ next, return: close }) }))).toEqual([ok[2]]);
    expect(close).not.toHaveBeenCalled();
  });

  it("logs cleanup failure without replacing the consumer's error or exposing its payload", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const primary = new Error("handing the answer over broke");
    const cleanup = new Error("source close broke", { cause: { payload: "private-provider-data" } });
    async function* source() {
      try {
        yield* ok;
      } finally {
        // biome-ignore lint/correctness/noUnsafeFinally: inject an iterator cleanup failure.
        throw cleanup;
      }
    }
    await expect(runEffect(Stream.runCollect(failOnEnd(eventStream(source, "[test]") as never, primary)))).rejects.toBe(
      primary,
    );
    expect(warn.mock.calls.flat().join(" ")).toContain("source close broke");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("private-provider-data");
  });

  it("diagnoses source cleanup failure when a paused consumer cancels", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const source = {
      next: vi.fn(async () => ({ done: false as const, value: ev.text("partial") })),
      return: vi.fn(async () => {
        throw new Error("cancel cleanup broke");
      }),
    };
    const pulled = Promise.withResolvers<void>();
    const abort = new AbortController();
    const done = Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const pull = yield* Stream.toPull(eventStream(() => ({ [Symbol.asyncIterator]: () => source }), "[test]"));
          yield* pull;
          pulled.resolve();
          yield* Effect.never;
        }),
      ),
      { signal: abort.signal },
    );
    await pulled.promise;
    abort.abort();
    await done;
    expect(source.return).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).toContain("cancel cleanup broke");
  });
});

describe("attachedFilesManifest: states, does not instruct", () => {
  it("gives name, size and path without telling the agent what to do with them", () => {
    const rendered = attachedFilesManifest([{ name: "spec.pdf", size: 1234, path: "/state/files/spec.pdf" }]);
    expect(rendered).toContain("spec.pdf");
    expect(rendered).toContain("1234");
    expect(rendered).toContain("/state/files/spec.pdf");
    // The earlier wording was "read them with your tools" — an assumption about the reader. An
    // assumption has to be verified, which is where a capability flag threaded through eight files
    // came from. An agent with a file tool decides for itself; one without says it cannot. Neither
    // needs this line to have guessed first.
    expect(rendered).not.toMatch(/your tools|read them/i);
  });

  it("renders nothing for no files", () => {
    expect(attachedFilesManifest([])).toBe("");
  });
});
