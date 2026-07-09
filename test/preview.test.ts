import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { streamReply } from "../src/channels/telegram/preview.ts";

const API = "http://tg.test";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A push-based event source, so a test controls exactly WHEN each event reaches streamReply. */
const eventSource = () => {
  const queue: AgentEvent[] = [];
  let notify: (() => void) | undefined;
  let ended = false;
  const iterable: AsyncIterable<AgentEvent> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as AgentEvent;
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
    push(e: AgentEvent): void {
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

async function* events(...list: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of list) yield e;
}

const neutral = (): string => "⚠️ neutral";

describe("streamReply single-writer pump (direct)", () => {
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
    const turn = streamReply(src.iterable, API, "BOT", { chatId: 1 }, neutral);
    const first = "ab";
    await vi.advanceTimersByTimeAsync(0); // placeholder sent
    src.push({ type: "text", delta: "a" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(inFlight).toBe(0); // no timer-driven partial answer flush
    src.push({ type: "text", delta: "b" });
    await vi.advanceTimersByTimeAsync(0);
    expect(inFlight).toBe(1); // the first answer frame is held in flight…
    src.push({ type: "text", delta: "c" });
    src.push({ type: "text", delta: "d" }); // …while newer frames arrive
    await vi.advanceTimersByTimeAsync(0);
    expect(maxInFlight).toBe(1); // SINGLE writer: nothing stacked behind the held edit
    releaseFirst();
    await vi.advanceTimersByTimeAsync(1600); // past the throttle → the next frame is the LATEST view
    expect(edits).toEqual([first, `${first}cd`]); // coalesced — never an intermediate, never out of order
    src.push({ type: "completed" });
    src.end();
    await turn;
    expect(edits.at(-1)).toBe(`${first}cd`); // the authoritative final write lands LAST
    expect(maxInFlight).toBe(1);
  });
});

describe("streamReply answer preview (direct)", () => {
  it("does not stream an answer before one preview interval has elapsed", async () => {
    const { sends, edits } = recordingFetch();
    await streamReply(
      events({ type: "text", delta: "OK." }, { type: "completed" }),
      API,
      "BOT",
      { chatId: 1 },
      neutral,
    );
    expect(sends).toEqual(["💭 Thinking…"]);
    expect(edits).toEqual(["OK."]);
  });

  it("starts answer preview on the next content update after one preview interval", async () => {
    vi.useFakeTimers();
    const { edits } = recordingFetch();
    const src = eventSource();
    const turn = streamReply(src.iterable, API, "BOT", { chatId: 1 }, neutral);
    await vi.advanceTimersByTimeAsync(0); // placeholder sent
    src.push({ type: "text", delta: "a" });
    await vi.advanceTimersByTimeAsync(1499);
    expect(edits).not.toContain("a");
    await vi.advanceTimersByTimeAsync(1);
    expect(edits).not.toContain("a"); // answerView has no timer; it only affects the next preview pass
    src.push({ type: "text", delta: "bc" });
    await vi.advanceTimersByTimeAsync(0);
    expect(edits).toContain("abc");
    src.push({ type: "completed" });
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
    const turn = streamReply(src.iterable, API, "BOT", { chatId: 1 }, neutral);
    await vi.advanceTimersByTimeAsync(0); // placeholder sent
    src.push({ type: "thinking", delta: "checking" });
    await vi.advanceTimersByTimeAsync(0); // first edit is now in flight
    src.push({ type: "text", delta: "answer" });
    await vi.advanceTimersByTimeAsync(0);
    releaseFirstEdit();
    await vi.advanceTimersByTimeAsync(1500);
    expect(edits).toEqual(["💭 checking", "💭 checking\n\nanswer"]);
    src.push({ type: "completed" });
    src.end();
    await turn;
    expect(edits.at(-1)).toBe("answer");
  });

  it("tool previews do not leak pending short answer text", async () => {
    vi.useFakeTimers();
    const { edits } = recordingFetch();
    const src = eventSource();
    const turn = streamReply(src.iterable, API, "BOT", { chatId: 1 }, neutral);
    await vi.advanceTimersByTimeAsync(0); // placeholder sent
    src.push({ type: "text", delta: "a" });
    await vi.advanceTimersByTimeAsync(0);
    src.push({ type: "tool_started", id: "t1", name: "read", args: { path: "AGENTS.md" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(edits).toEqual(["🔧 read AGENTS.md …"]);
    src.push({ type: "completed" });
    src.end();
    await turn;
    expect(edits.at(-1)).toBe("a");
  });
});

describe("streamReply terminal writes (direct)", () => {
  it("completed → the preview message is edited into the final answer", async () => {
    const { sends, edits } = recordingFetch();
    await streamReply(
      events({ type: "text", delta: "the answer" }, { type: "completed" }),
      API,
      "BOT",
      { chatId: 1 },
      neutral,
    );
    expect(sends.length).toBe(1); // ONE preview message, never a second
    expect(edits.at(-1)).toBe("the answer"); // …edited into the answer in place
  });

  it("failed → the onError text is delivered and the failure is rethrown for the operator log", async () => {
    const { edits } = recordingFetch();
    await expect(
      streamReply(events({ type: "failed", details: "boom", retryable: true }), API, "BOT", { chatId: 1 }, neutral),
    ).rejects.toThrow(/agent failed: boom/);
    expect(edits.at(-1)).toBe("⚠️ neutral"); // the user was told, in the same message
  });

  it("a stream that ends without a terminal event delivers the neutral notice and throws (SPEC MUST 1)", async () => {
    const { sends, edits } = recordingFetch();
    await expect(
      streamReply(events({ type: "text", delta: "partial…" }), API, "BOT", { chatId: 1 }, neutral),
    ).rejects.toThrow(/stream ended without a terminal event/);
    expect([...sends, ...edits]).toContain("⚠️ neutral"); // not silence, not a silent delete of partial work
  });

  it("takes over a pre-sent message id (the ⏳ notice) instead of sending its own placeholder", async () => {
    const { sends, edits } = recordingFetch();
    await streamReply(
      events({ type: "text", delta: "answer" }, { type: "completed" }),
      API,
      "BOT",
      { chatId: 1 },
      neutral,
      77, // an existing message to morph
    );
    expect(sends.length).toBe(0); // no second placeholder
    expect(edits.at(-1)).toBe("answer"); // the notice morphed into the answer
  });
});
