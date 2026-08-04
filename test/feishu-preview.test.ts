import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import {
  ANSWER_ELEMENT_ID,
  PROCESS_ELEMENT_ID,
  finalCardJson,
  streamingCardJson,
} from "../src/channels/feishu/card.ts";
import type { FeishuApi } from "../src/channels/feishu/feishu-api.ts";
import { streamFeishuReply } from "../src/channels/feishu/preview.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A push-based event source, so a test controls exactly WHEN each event reaches the stream. */
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

interface ElementWrite {
  cardId: string;
  elementId: string;
  content: string;
  sequence: number;
}

/** A recording FeishuApi fake — only the surface the preview touches. */
function fakeApi() {
  const created: string[] = [];
  const elementWrites: ElementWrite[] = [];
  const cardWrites: { cardId: string; cardJson: string; sequence: number }[] = [];
  const api = {
    async createCard(cardJson: string) {
      created.push(cardJson);
      return `c${created.length}`;
    },
    async updateCardElement(cardId: string, elementId: string, content: string, sequence: number) {
      elementWrites.push({ cardId, elementId, content, sequence });
    },
    async updateCard(cardId: string, cardJson: string, sequence: number) {
      cardWrites.push({ cardId, cardJson, sequence });
    },
    async sendMessage() {
      return "om_1";
    },
    async replyMessage() {
      return "om_1";
    },
    async sendText() {
      return "om_2";
    },
    async editTextMessage() {},
    async deleteMessage() {},
  } as unknown as FeishuApi;
  return { api, created, elementWrites, cardWrites };
}

const neutral = (): string => "⚠️ neutral";

describe("streaming card shape (pure)", () => {
  it("mounts TWO elements: the volatile process block and an EMPTY append-only answer", () => {
    const card = JSON.parse(streamingCardJson("💭 Thinking…")) as {
      config: { streaming_mode: boolean };
      body: { elements: { element_id: string; content: string }[] };
    };
    expect(card.config.streaming_mode).toBe(true);
    expect(card.body.elements.map((e) => e.element_id)).toEqual([PROCESS_ELEMENT_ID, ANSWER_ELEMENT_ID]);
    expect(card.body.elements[0]?.content).toBe("💭 Thinking…");
    expect(card.body.elements[1]?.content).toBe(""); // the first answer snapshot is a prefix extension of ""
  });

  it("settles to the answer element alone (the process block is preview-only)", () => {
    const card = JSON.parse(finalCardJson("done")) as {
      config: { streaming_mode: boolean };
      body: { elements: { element_id: string; content: string }[] };
    };
    expect(card.config.streaming_mode).toBe(false);
    expect(card.body.elements.map((e) => e.element_id)).toEqual([ANSWER_ELEMENT_ID]);
  });
});

describe("streamFeishuReply two-element streaming (direct)", () => {
  it("process churn (sliding thinking tail, tool flips) never rewrites the answer element", async () => {
    vi.useFakeTimers();
    const { api, created, elementWrites, cardWrites } = fakeApi();
    const src = eventSource();
    const turn = streamFeishuReply(src.iterable, api, { chatId: "oc_1" }, neutral);
    await vi.advanceTimersByTimeAsync(0); // mount flush
    expect(created).toHaveLength(1);

    // Thinking longer than the 280-point tail window — every later delta slides the line's HEAD.
    src.push({ type: "thinking", delta: "a".repeat(300) });
    await vi.advanceTimersByTimeAsync(1100);
    src.push({ type: "text", delta: "hello" });
    await vi.advanceTimersByTimeAsync(1100); // answer ages past the reveal window
    src.push({ type: "text", delta: " wor" });
    await vi.advanceTimersByTimeAsync(1100); // → answer frame 1
    src.push({ type: "text", delta: "ld" });
    await vi.advanceTimersByTimeAsync(1100); // → answer frame 2 (strict prefix extension of frame 1)

    // Churn-only phase: the answer element must FREEZE while the process block keeps changing —
    // an equal-content rewrite here would burn quota and re-trigger the client's animation.
    const answerWritesBeforeChurn = elementWrites.filter((w) => w.elementId === ANSWER_ELEMENT_ID).length;
    src.push({ type: "thinking", delta: "b".repeat(50) }); // slides the tail again
    await vi.advanceTimersByTimeAsync(1100);
    src.push({ type: "tool_started", id: "t1", name: "bash", args: { cmd: "ls" } });
    await vi.advanceTimersByTimeAsync(1100);
    src.push({ type: "tool_ended", id: "t1", isError: false, content: "ok" }); // the …→✓ flip is process churn too
    await vi.advanceTimersByTimeAsync(1100);
    expect(elementWrites.filter((w) => w.elementId === ANSWER_ELEMENT_ID).length).toBe(answerWritesBeforeChurn);

    src.push({ type: "completed" });
    src.end();
    await turn;

    const processWrites = elementWrites.filter((w) => w.elementId === PROCESS_ELEMENT_ID);
    const answerWrites = elementWrites.filter((w) => w.elementId === ANSWER_ELEMENT_ID);

    // The process element carried the churn: thinking tail slides and the tool line in both states.
    expect(processWrites.length).toBeGreaterThanOrEqual(3);
    expect(processWrites.every((w) => w.content.startsWith("💭"))).toBe(true);
    expect(processWrites.some((w) => w.content.includes("🔧 Bash ls …"))).toBe(true);
    expect(processWrites.some((w) => w.content.includes("🔧 Bash ls ✓"))).toBe(true);
    expect(processWrites.every((w) => !w.content.includes("hello"))).toBe(true); // the answer never leaks in

    // The answer element stayed prefix-stable: pure answer text, each frame a STRICT extension of the
    // previous one (equality would mean a pointless rewrite — the dedup guard is what this pins).
    expect(answerWrites.length).toBeGreaterThanOrEqual(2);
    expect(answerWrites.every((w) => !/💭|🔧/.test(w.content))).toBe(true);
    for (let i = 1; i < answerWrites.length; i++) {
      const prev = answerWrites[i - 1]?.content ?? "";
      const next = answerWrites[i]?.content ?? "";
      expect(next.startsWith(prev)).toBe(true);
      expect(next.length).toBeGreaterThan(prev.length);
    }
    expect(answerWrites.at(-1)?.content).toBe("hello world");

    // The card's sequence is strictly increasing across BOTH elements (single-writer pump).
    const sequences = elementWrites.map((w) => w.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(new Set(sequences).size).toBe(sequences.length);

    // Settle replaced the entity with the final answer alone, streaming off.
    const settled = JSON.parse(cardWrites.at(-1)?.cardJson ?? "{}") as {
      config: { streaming_mode: boolean };
      body: { elements: { element_id: string; content: string }[] };
    };
    expect(settled.config.streaming_mode).toBe(false);
    expect(settled.body.elements).toHaveLength(1);
    expect(settled.body.elements[0]?.content).toBe("hello world");
  });

  it("an answer-only stream clears the placeholder: the process element goes empty once the answer reveals", async () => {
    vi.useFakeTimers();
    const { api, created, elementWrites } = fakeApi();
    const src = eventSource();
    const turn = streamFeishuReply(src.iterable, api, { chatId: "oc_1" }, neutral);
    await vi.advanceTimersByTimeAsync(0); // mount flush — process seeded with the placeholder
    const mounted = JSON.parse(created[0] ?? "{}") as { body: { elements: { content: string }[] } };
    expect(mounted.body.elements[0]?.content).toBe("💭 Thinking…");

    src.push({ type: "text", delta: "OK" });
    await vi.advanceTimersByTimeAsync(1100); // young answer: placeholder stays, nothing written yet
    expect(elementWrites).toHaveLength(0);
    src.push({ type: "text", delta: " then" });
    await vi.advanceTimersByTimeAsync(1100); // answer reveals → placeholder cleared in the same flush
    src.push({ type: "completed" });
    src.end();
    await turn;

    const processWrites = elementWrites.filter((w) => w.elementId === PROCESS_ELEMENT_ID);
    const answerWrites = elementWrites.filter((w) => w.elementId === ANSWER_ELEMENT_ID);
    expect(processWrites.map((w) => w.content)).toEqual([""]); // one write: the placeholder clearing
    expect(answerWrites.at(-1)?.content).toBe("OK then");
  });

  it("an over-budget process block elides at LINE boundaries: newest complete tool lines win", async () => {
    vi.useFakeTimers();
    const { api, elementWrites } = fakeApi();
    const src = eventSource();
    const turn = streamFeishuReply(src.iterable, api, { chatId: "oc_1" }, neutral);
    await vi.advanceTimersByTimeAsync(0); // mount flush
    // 30 tool lines × ~60 points ≈ 1800 points — well past the 1000-point process budget.
    for (let i = 0; i < 30; i++) {
      src.push({
        type: "tool_started",
        id: `t${i}`,
        name: `tool${String(i).padStart(2, "0")}`,
        args: { p: "x".repeat(60) },
      });
    }
    await vi.advanceTimersByTimeAsync(1100);
    src.push({ type: "completed" });
    src.end();
    await turn;

    const last = elementWrites.filter((w) => w.elementId === PROCESS_ELEMENT_ID).at(-1)?.content ?? "";
    expect(Array.from(last).length).toBeLessThanOrEqual(1000);
    const lines = last.split("\n");
    expect(lines[0]).toBe("…"); // the elision marker — something WAS dropped
    expect(lines.slice(1).every((l) => l.startsWith("🔧 Tool"))).toBe(true); // only COMPLETE lines survive
    expect(last).toContain("Tool29"); // newest kept…
    expect(last).not.toContain("Tool00"); // …oldest dropped
  });

  it("an unchanged view writes nothing (no idle churn against the cardkit quota)", async () => {
    vi.useFakeTimers();
    const { api, elementWrites } = fakeApi();
    const src = eventSource();
    const turn = streamFeishuReply(src.iterable, api, { chatId: "oc_1" }, neutral);
    await vi.advanceTimersByTimeAsync(0); // mount flush
    src.push({ type: "thinking", delta: "short" });
    await vi.advanceTimersByTimeAsync(1100);
    const after = elementWrites.length;
    // tool_ended for an unknown id changes nothing in the view → no write may follow.
    src.push({ type: "tool_ended", id: "ghost", isError: false, content: "ok" });
    await vi.advanceTimersByTimeAsync(2500);
    expect(elementWrites.length).toBe(after);
    src.push({ type: "completed" });
    src.end();
    await turn;
  });
});
