/** A channel's turn as one invoke: what it asks the agent, and how its stream is owned. */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachedFilesManifest, turnStream } from "../src/channels/kit/invoke-turn-kit.ts";
import { PortFailure } from "../src/effect-port.ts";
import { log } from "../src/log.ts";
import type { InvokeEvent, InvokeRequest } from "../src/protocol.ts";
import { run as runEffect } from "./channel-effects.ts";
import { ev } from "./scripted-run.ts";

afterEach(() => vi.restoreAllMocks());

const ok: InvokeEvent[] = [ev.accepted(), ev.text("answer"), ev.ended()];

const turn = (agent: { invoke: (request: InvokeRequest) => AsyncIterable<InvokeEvent> }, resolve = async () => {}) =>
  turnStream({
    agent,
    label: "[test]",
    source: { kind: "channel", name: "test" },
    resolve,
    turn: () => ({ sessionId: "s", idempotencyKey: "msg-1", prompt: { text: "hi" } }),
    retryableLoadFailure: () => false,
  });

const read = (events: Stream.Stream<InvokeEvent, PortFailure>) => runEffect(Stream.runCollect(events));

/** A consumer that fails on the turn's end — the shape of a channel whose delivery throws at the answer. */
const failOnEnd = (events: Stream.Stream<InvokeEvent, PortFailure>, error: Error) =>
  events.pipe(
    Stream.tap((event) =>
      Effect.try({
        try: () => {
          if (event.type === "entry" && event.entry.kind === "run_ended") throw error;
        },
        catch: (cause) => new PortFailure(cause),
      }),
    ),
  );

it("asks once, queued behind whatever runs in the session, under the turn's key and the channel's name", async () => {
  const invoke = vi.fn(async function* (_request: InvokeRequest) {
    yield* ok;
  });
  expect(await read(turn({ invoke }))).toEqual(ok);
  expect(invoke).toHaveBeenCalledExactlyOnceWith({
    sessionId: "s",
    idempotencyKey: "msg-1",
    prompt: { text: "hi" },
    whenBusy: "queue",
    source: { kind: "channel", name: "test" },
  });
});

it("a preparation that fails is the invoke's refusal, carrying the channel's verdict on a redelivery", async () => {
  const invoke = vi.fn();
  const events = await read(
    turn({ invoke }, async () => {
      throw new Error("the attachment is gone");
    }),
  );
  expect(events).toMatchObject([
    {
      type: "rejected",
      error: { message: "could not prepare the turn: Error: the attachment is gone", retryable: false },
    },
  ]);
  expect(invoke).not.toHaveBeenCalled();
});

it("keeps source pulls behind consumer demand", async () => {
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const next = vi
    .fn()
    .mockResolvedValueOnce({ done: false, value: ok[0] })
    .mockResolvedValueOnce({ done: false, value: ok[1] });
  const agent = { invoke: () => ({ [Symbol.asyncIterator]: () => ({ next, return: close }) }) };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(turn(agent));
        expect(next).not.toHaveBeenCalled();
        expect(yield* pull).toEqual([ok[0]]);
        expect(next).toHaveBeenCalledTimes(1);
        expect(yield* pull).toEqual([ok[1]]);
        expect(close).not.toHaveBeenCalled();
      }),
    ),
  );
  expect(close).toHaveBeenCalledTimes(1);
});

it("preserves natural exhaustion without calling return on an already-closed source", async () => {
  const close = vi.fn(async () => {
    throw new Error("source was already closed");
  });
  const next = vi
    .fn()
    .mockResolvedValueOnce({ done: false, value: ok[2] })
    .mockResolvedValueOnce({ done: true, value: undefined });
  const agent = { invoke: () => ({ [Symbol.asyncIterator]: () => ({ next, return: close }) }) };
  expect(await read(turn(agent))).toEqual([ok[2]]);
  expect(close).not.toHaveBeenCalled();
});

it("a consumer failure at the end keeps its identity and closes the source", async () => {
  const error = new Error("handing the answer over failed");
  let closed = false;
  const agent = {
    async *invoke() {
      try {
        yield* ok;
      } finally {
        closed = true;
      }
    },
  };
  await expect(read(failOnEnd(turn(agent), error))).rejects.toBe(error);
  expect(closed).toBe(true);
});

it("logs cleanup failure without replacing the consumer's error or exposing its payload", async () => {
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const primary = new Error("handing the answer over broke");
  const cleanup = new Error("source close broke", { cause: { payload: "private-provider-data" } });
  const agent = {
    async *invoke() {
      try {
        yield* ok;
      } finally {
        // biome-ignore lint/correctness/noUnsafeFinally: inject an iterator cleanup failure.
        throw cleanup;
      }
    },
  };
  await expect(read(failOnEnd(turn(agent), primary))).rejects.toBe(primary);
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
  const agent = { invoke: () => ({ [Symbol.asyncIterator]: () => source }) };
  const pulled = Promise.withResolvers<void>();
  const abort = new AbortController();
  const done = Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const pull = yield* Stream.toPull(turn(agent));
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
