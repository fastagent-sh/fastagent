/**
 * pi's session events as a run's live events (live-events.ts): thinking deltas only from a readable block, and a
 * tool call's status line, sent when it changes.
 */
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { liveEvents } from "../src/harnesses/pi/live-events.ts";

const event = (fields: Record<string, unknown>) => fields as unknown as AgentSessionEvent;

describe("thinking deltas", () => {
  it("drops a redacted block's placeholder delta and streams a readable one", () => {
    const partial = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "because" },
        // As pi's Bedrock path streams encrypted reasoning: the block is flagged before its placeholder delta is pushed.
        { type: "thinking", thinking: "[Reasoning redacted]", redacted: true },
      ],
    } as unknown as AssistantMessage;
    const project = liveEvents();
    const delta = (contentIndex: number, text: string) =>
      project(
        event({
          type: "message_update",
          message: partial,
          assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: text, partial },
        }),
      );
    expect(delta(0, "because")).toEqual({ type: "message_delta", channel: "thinking", delta: "because" });
    expect(delta(1, "[Reasoning redacted]")).toBeUndefined();
  });
});

describe("tool_progress: an outer call's status line, sent when it changes", () => {
  const started = (toolCallId: string, toolName: string, args: unknown, parentToolCallId?: string) =>
    event({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    });
  const progress = (toolCallId: string, text: string, parentToolCallId?: string) =>
    event({
      type: "tool_execution_update",
      toolCallId,
      toolName: "t",
      args: {},
      partialResult: { content: text ? [{ type: "text", text }] : [] },
      ...(parentToolCallId ? { parentToolCallId } : {}),
    });

  it("is the last visible line, untruncated: a bare \\r ends a line, terminal control sequences are not text", () => {
    const project = liveEvents();
    project(started("t1", "bash", { command: "npm test" }));
    const long = "x".repeat(500);
    const sent = [
      progress("t1", ""), // a shell that printed nothing yet
      progress("t1", "line one\nline two\n\n"),
      progress("t1", "line one\nline two\n\n"), // unchanged: not sent again
      progress("t1", "downloading 10%\rdownloading 60%"),
      progress("t1", "\u001b[32mPASS\u001b[0m 42 passed\r\n"),
      progress("t1", `head\n${long}`),
    ].map(project);
    expect(sent).toEqual([
      undefined,
      { type: "tool_progress", toolCallId: "t1", text: "line two" },
      undefined,
      { type: "tool_progress", toolCallId: "t1", text: "downloading 60%" },
      { type: "tool_progress", toolCallId: "t1", text: "PASS 42 passed" },
      { type: "tool_progress", toolCallId: "t1", text: long },
    ]);
  });

  it("reports a nested call starting as its outer call's status, at any depth; a nested call's own output is not", () => {
    const project = liveEvents();
    expect(project(started("outer", "codemode", { code: "..." }))).toMatchObject({ type: "tool_started" });
    expect(project(started("outer/1", "weather", { city: "London\nUK", days: 3 }, "outer"))).toEqual({
      type: "tool_progress",
      toolCallId: "outer",
      text: "weather London UK",
    });
    expect(project(started("outer/1/1", "fetch", {}, "outer/1"))).toEqual({
      type: "tool_progress",
      toolCallId: "outer",
      text: "fetch",
    });
    expect(project(progress("outer/1/1", "downloaded 3 MB", "outer/1"))).toBeUndefined();
    // An unchanged line is not sent again, whoever set it; the outer call's own new line replaces it.
    expect(project(progress("outer", "fetch"))).toBeUndefined();
    expect(project(progress("outer", "summarizing"))).toEqual({
      type: "tool_progress",
      toolCallId: "outer",
      text: "summarizing",
    });
  });
});

describe("retries", () => {
  it("a model retry and a compaction's summarization retry are both retry_scheduled, with pi's numbers", () => {
    for (const type of ["auto_retry_start", "summarization_retry_scheduled"]) {
      const retry = event({ type, attempt: 2, maxAttempts: 3, delayMs: 125, errorMessage: "temporarily unavailable" });
      expect(liveEvents()(retry), type).toEqual({
        type: "retry_scheduled",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 125,
        reason: "temporarily unavailable",
      });
    }
  });
});
