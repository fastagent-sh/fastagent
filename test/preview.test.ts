import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnEvent as InvokeEvent } from "../src/channels/kit/invoke-turn-kit.ts";
import { ev } from "./scripted-run.ts";
import { telegramReply } from "../src/channels/telegram/preview.ts";
import { run, stream } from "./channel-effects.ts";

const API = "http://tg.test";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A push-based event source, so a test controls exactly WHEN each event reaches telegramReply. It opens with the
 *  invoke's receipt, which names the run the pushed events belong to. */
const eventSource = () => {
  const queue: InvokeEvent[] = [ev.accepted()];
  let notify: (() => void) | undefined;
  let ended = false;
  const iterable: AsyncIterable<InvokeEvent> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as InvokeEvent;
          continue;
        }
        if (ended) return;
        await new Promise<void>((r) => {
          notify = r;
        });
      }
    },
  };
  return {
    iterable,
    push(e: InvokeEvent): void {
      queue.push(e);
      notify?.();
      notify = undefined;
    },
    end(): void {
      ended = true;
      notify?.();
      notify = undefined;
    },
  };
};

/** Record every sendMessage/editMessageText the preview writes, replying ok to all. */
const recordingFetch = () => {
  const sends: string[] = [];
  const edits: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { text?: string }) : {};
      if (String(url).endsWith("/sendMessage")) sends.push(body.text ?? "");
      if (String(url).endsWith("/editMessageText")) edits.push(body.text ?? "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }),
  );
  return { sends, edits };
};

/** One invoke's events: its receipt, then `list`. */
async function* events(...list: InvokeEvent[]): AsyncIterable<InvokeEvent> {
  yield ev.accepted();
  for (const e of list) yield e;
}

const neutral = (): string => "⚠️ neutral";

const okSend = () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });

describe("telegramReply single-writer pump (direct)", () => {
  it("one edit in flight; frames coalesce to the LATEST view — no stale or out-of-order frame", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const edits: string[] = [];
    let releaseFirst!: () => void;
    const firstEditGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as { text?: string }) : {};
        if (String(url).endsWith("/editMessageText")) {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (edits.length === 0) await firstEditGate; // hold the FIRST edit in flight
          edits.push(body.text ?? "");
          inFlight--;
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }),
    );
    const src = eventSource();
    const turn = run(telegramReply(stream(src.iterable), API, "BOT", { chatId: 1 }, neutral));
    const first = "ab";
    await vi.advanceTimersByTimeAsync(0); // placeholder sent
    src.push(ev.text("a"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(inFlight).toBe(0); // no timer-driven partial answer flush
    src.push(ev.text("b"));
    await vi.advanceTimersByTimeAsync(0);
    expect(inFlight).toBe(1); // the first answer frame is held in flight…
    src.push(ev.text("c"));
    src.push(ev.text("d")); // …while newer frames arrive
    await vi.advanceTimersByTimeAsync(0);
    expect(maxInFlight).toBe(1); // SINGLE writer: nothing stacked behind the held edit
    releaseFirst();
    await vi.advanceTimersByTimeAsync(1600); // past the throttle → the next frame is the LATEST view
    expect(edits).toEqual([first, `${first}cd`]); // coalesced — never an intermediate, never out of order
    src.push(ev.ended());
    src.end();
    await turn;
    expect(edits.at(-1)).toBe(`${first}cd`); // the authoritative final write lands LAST
    expect(maxInFlight).toBe(1);
  });
});

describe("telegramReply answer preview (direct)", () => {
  it("does not stream an answer before one preview interval has elapsed", async () => {
    const { sends, edits } = recordingFetch();
    await run(telegramReply(stream(events(ev.text("OK."), ev.ended())), API, "BOT", { chatId: 1 }, neutral));
    expect(sends).toEqual(["💭 Thinking…"]);
    expect(edits).toEqual(["OK."]);
  });

  it("starts answer preview on the next content update after one preview interval", async () => {
    vi.useFakeTimers();
    const { edits } = recordingFetch();
    const src = eventSource();
    const turn = run(telegramReply(stream(src.iterable), API, "BOT", { chatId: 1 }, neutral));
    await vi.advanceTimersByTimeAsync(0); // placeholder sent
    src.push(ev.text("a"));
    await vi.advanceTimersByTimeAsync(1499);
    expect(edits).not.toContain("a");
    await vi.advanceTimersByTimeAsync(1);
    expect(edits).not.toContain("a"); // answerView has no timer; it only affects the next preview pass
    src.push(ev.text("bc"));
    await vi.advanceTimersByTimeAsync(0);
    expect(edits).toContain("abc");
    src.push(ev.ended());
    src.end();
    await turn;
    expect(edits.at(-1)).toBe("abc");
  });

  it("ages the first answer preview from the text delta, not from a delayed preview pass", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    let releaseFirstEdit!: () => void;
    const firstEditGate = new Promise<void>((r) => {
      releaseFirstEdit = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as { text?: string }) : {};
        if (String(url).endsWith("/editMessageText")) {
          if (edits.length === 0) await firstEditGate;
          edits.push(body.text ?? "");
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }),
    );
    const src = eventSource();
    const turn = run(telegramReply(stream(src.iterable), API, "BOT", { chatId: 1 }, neutral));
    await vi.advanceTimersByTimeAsync(0); // placeholder sent
    src.push(ev.thinking("checking"));
    await vi.advanceTimersByTimeAsync(0); // first edit is now in flight
    src.push(ev.text("answer"));
    await vi.advanceTimersByTimeAsync(0);
    releaseFirstEdit();
    await vi.advanceTimersByTimeAsync(1500);
    expect(edits).toEqual(["💭 checking", "💭 checking\n\nanswer"]);
    src.push(ev.ended());
    src.end();
    await turn;
    expect(edits.at(-1)).toBe("answer");
  });

  it("a retrying event shows the backoff notice; the next progress event clears it", async () => {
    vi.useFakeTimers();
    const { edits } = recordingFetch();
    const src = eventSource();
    const turn = run(telegramReply(stream(src.iterable), API, "BOT", { chatId: 1 }, neutral));
    await vi.advanceTimersByTimeAsync(0); // placeholder sent
    src.push(ev.retrying());
    await vi.advanceTimersByTimeAsync(0);
    expect(edits).toEqual(["⏳ Temporary problem — retrying…"]);
    src.push(ev.toolStarted("t1", "read"));
    await vi.advanceTimersByTimeAsync(0);
    expect(edits.at(-1)).toBe("🔧 Read …"); // notice closed by progress, no stale retry line
    src.push(ev.ended());
    src.end();
    await turn;
  });

  it("tool previews do not leak pending short answer text", async () => {
    vi.useFakeTimers();
    const { edits } = recordingFetch();
    const src = eventSource();
    const turn = run(telegramReply(stream(src.iterable), API, "BOT", { chatId: 1 }, neutral));
    await vi.advanceTimersByTimeAsync(0); // placeholder sent
    src.push(ev.text("a"));
    await vi.advanceTimersByTimeAsync(0);
    src.push(ev.toolStarted("t1", "read", { path: "AGENTS.md" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(edits).toEqual(["🔧 Read AGENTS.md …"]);
    src.push(ev.ended());
    src.end();
    await turn;
    expect(edits.at(-1)).toBe("a");
  });
});

describe("telegramReply terminal writes (direct)", () => {
  it("completed → the preview message is edited into the final answer", async () => {
    const { sends, edits } = recordingFetch();
    await run(telegramReply(stream(events(ev.text("the answer"), ev.ended())), API, "BOT", { chatId: 1 }, neutral));
    expect(sends.length).toBe(1); // ONE preview message, never a second
    expect(edits.at(-1)).toBe("the answer"); // …edited into the answer in place
  });

  it("failed → the onError text is delivered and the failure is rethrown for the operator log", async () => {
    const { edits } = recordingFetch();
    await expect(
      run(telegramReply(stream(events(ev.failed("boom", { retryable: true }))), API, "BOT", { chatId: 1 }, neutral)),
    ).rejects.toThrow(/agent failed: boom/);
    expect(edits.at(-1)).toBe("⚠️ neutral"); // the user was told, in the same message
  });

  it("a stream that ends without a terminal event delivers the neutral notice and throws (SPEC MUST 1)", async () => {
    const { sends, edits } = recordingFetch();
    await expect(
      run(telegramReply(stream(events(ev.text("partial…"))), API, "BOT", { chatId: 1 }, neutral)),
    ).rejects.toThrow(/stream ended without a terminal event/);
    expect([...sends, ...edits]).toContain("⚠️ neutral"); // not silence, not a silent delete of partial work
  });

  it("takes over a pre-sent message id (the ⏳ notice) instead of sending its own placeholder", async () => {
    const { sends, edits } = recordingFetch();
    await run(
      telegramReply(
        stream(events(ev.text("answer"), ev.ended())),
        API,
        "BOT",
        { chatId: 1 },
        neutral,
        77, // an existing message to morph
      ),
    );
    expect(sends.length).toBe(0); // no second placeholder
    expect(edits.at(-1)).toBe("answer"); // the notice morphed into the answer
  });
});

describe("telegramReply preview frames are droppable (direct)", () => {
  it("absorbs a rate limit on the placeholder send — losing it would cost the whole turn's preview", async () => {
    vi.useFakeTimers();
    let sends = 0;
    const edits: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as { text?: string }) : {};
        if (String(url).endsWith("/sendMessage")) {
          sends++;
          if (sends === 1) {
            return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 1 } }), { status: 429 });
          }
          return okSend();
        }
        if (String(url).endsWith("/editMessageText")) edits.push(body.text ?? "");
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }),
    );
    const src = eventSource();
    const turn = run(telegramReply(stream(src.iterable), API, "BOT", { chatId: 1 }, neutral));
    await vi.advanceTimersByTimeAsync(2_100); // the placeholder retries past Telegram's 1s flood wait
    expect(sends).toBe(2);
    src.push(ev.text("hello"));
    src.push(ev.ended());
    src.end();
    await vi.advanceTimersByTimeAsync(2_000);
    await turn;
    expect(edits.at(-1)).toBe("hello"); // the preview survived, so the answer edits it in place
  });

  it("a rate-limited preview frame does not park the turn on its flood wait", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    let frames = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as { text?: string }) : {};
        if (String(url).endsWith("/editMessageText")) {
          frames++;
          // Telegram rate-limits edits far tighter than sends; a preview frame is the common victim.
          if (frames === 1) {
            return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 25 } }), { status: 429 });
          }
          edits.push(body.text ?? "");
        }
        if (String(url).endsWith("/sendMessage")) return okSend();
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }),
    );
    const src = eventSource();
    const turn = run(telegramReply(stream(src.iterable), API, "BOT", { chatId: 1 }, neutral));
    await vi.advanceTimersByTimeAsync(0); // placeholder sent
    src.push(ev.text("hel"));
    await vi.advanceTimersByTimeAsync(1600); // the partial answer ages into view…
    src.push(ev.text("lo")); // …and this frame carries it, rate-limited below
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toBe(1);
    src.push(ev.ended());
    src.end();
    // The answer must land without waiting out Telegram's 25s flood wait for a frame nobody needs:
    // the next frame redraws the same view, and the final write is authoritative.
    const started = Date.now();
    let elapsed = -1;
    void turn.then(() => {
      elapsed = Date.now() - started;
    });
    // Well past any flood wait: the question is not WHETHER the answer lands, but whether it waited.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(5_000);
    expect(edits.at(-1)).toBe("hello");
    await turn;
  });
});
