import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import type { Message } from "../src/agent-api.ts";
import type { TurnEvent } from "../src/channels/kit/invoke-turn-kit.ts";
import { answerKeyOf, gatedReply } from "../src/channels/kit/turn-gate.ts";

const own = (status: Message["status"], answer?: string): Message => ({
  id: "m2",
  sessionId: "s",
  status,
  ...(answer === undefined ? {} : { answer: { entryId: answer, text: "the shared answer" } }),
});

/** The events of a message that was recorded, then answered. */
const events = (answer: string | undefined = "e7"): Stream.Stream<TurnEvent> =>
  Stream.fromIterable<TurnEvent>([
    { type: "message", message: own("queued") },
    { type: "done", message: own("completed", answer) },
  ]);

function run(opts: { held: boolean; delivered?: string[]; earlier?: Effect.Effect<void> }) {
  const rendered: string[] = [];
  const skipped: string[] = [];
  const done = Effect.runPromise(
    Effect.scoped(
      gatedReply({
        events: events() as never,
        held: opts.held,
        awaitEarlier: opts.earlier ?? Effect.void,
        delivered: (key) => (opts.delivered ?? []).includes(key),
        skipped: (key) => Effect.sync(() => void skipped.push(key)),
        render: (stream) => Stream.runForEach(stream, (event) => Effect.sync(() => void rendered.push(event.type))),
      }),
    ),
  );
  return { done, rendered, skipped };
}

describe("a steered turn's reply", () => {
  it("passes through live when its answer cannot be shared", async () => {
    const { done, rendered, skipped } = run({ held: false, delivered: ["s:e7"] });
    await done;
    expect(rendered).toEqual(["message", "done"]);
    expect(skipped).toEqual([]);
  });

  it("is held until its message ends, then rendered when nobody delivered its answer", async () => {
    const { done, rendered } = run({ held: true });
    await done;
    expect(rendered).toEqual(["message", "done"]);
  });

  it("renders nothing when an earlier turn delivered the answer it shares", async () => {
    const { done, rendered, skipped } = run({ held: true, delivered: ["s:e7"] });
    await done;
    expect(rendered).toEqual([]);
    expect(skipped).toEqual(["s:e7"]);
  });

  it("looks at what was delivered only after the earlier turns ended", async () => {
    const delivered: string[] = [];
    const earlier = Effect.sync(() => void delivered.push("s:e7"));
    const { done, rendered, skipped } = run({ held: true, delivered, earlier });
    await done;
    expect(rendered).toEqual([]);
    expect(skipped).toEqual(["s:e7"]);
  });

  it("names an answer by its session and entry", () => {
    expect(answerKeyOf(own("completed", "e7"))).toBe("s:e7");
    expect(answerKeyOf(own("failed"))).toBeUndefined();
  });
});
