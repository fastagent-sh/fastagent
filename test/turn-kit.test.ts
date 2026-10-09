/**
 * `retryable` classification — the one bit every SPEC failure carries, and the reason a channel
 * either retries or reports. Structured status/code first, prose only as the last-resort ceiling.
 */
import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log.ts";
import { attachedFilesManifest } from "../src/channels/kit/invoke-turn-kit.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { toSessionEvent } from "../src/harnesses/pi/invoke-session.ts";
import {
  agentEventProjection,
  answerThinking,
  classifyRetryable,
  streamsThinkingDelta,
  errorToTerminal,
  toPiPromptOptions,
  toTerminal,
} from "../src/harnesses/pi/turn-kit.ts";
import type { Json } from "../src/agent.ts";

describe("classifyRetryable (structured signal first, prose as the ceiling)", () => {
  it("a status decides, whatever the prose says", () => {
    expect(classifyRetryable("bad request mentioning timeout", { status: 400 })).toBe(false);
    expect(classifyRetryable("nope", { status: 429 })).toBe(true);
    expect(classifyRetryable("nope", { status: 503 })).toBe(true);
    expect(classifyRetryable("nope", { status: 401 })).toBe(false);
  });

  it("a network code decides; an unknown one falls through to prose", () => {
    expect(classifyRetryable("x", { code: "ECONNRESET" })).toBe(true);
    expect(classifyRetryable("x", { code: "ETIMEDOUT" })).toBe(true);
    expect(classifyRetryable("x", { code: "429" })).toBe(true); // a status carried as a string
    expect(classifyRetryable("x", { code: 503 })).toBe(true);
    expect(classifyRetryable("x", { code: "ENOENT" })).toBe(false);
  });

  it("prose is the ceiling, not the classifier", () => {
    expect(classifyRetryable("model is overloaded, try again", {})).toBe(true);
    expect(classifyRetryable("request timed out", {})).toBe(true);
    expect(classifyRetryable("invalid api key", {})).toBe(false);
  });
});

describe("terminals read the harness's own signal", () => {
  const message = (over: Record<string, unknown>) =>
    ({
      role: "assistant",
      content: [],
      api: "faux",
      provider: "faux",
      model: "faux",
      usage: { input: 0, output: 0 },
      ...over,
    }) as never;

  it("a clean stop is completed", () => {
    expect(toTerminal(message({ stopReason: "stop" }))).toEqual({ type: "completed" });
  });

  it("diagnostics carry the code, and the LAST code-bearing one is the terminal cause", () => {
    const retryable = toTerminal(
      message({ stopReason: "error", errorMessage: "upstream", diagnostics: [{ error: { code: "503" } }] }),
    );
    expect(retryable).toMatchObject({ type: "failed", retryable: true });
    const terminal = toTerminal(
      message({
        stopReason: "error",
        errorMessage: "upstream",
        // an earlier transient must not classify a terminal auth failure as retryable
        diagnostics: [{ error: { code: "503" } }, { error: { code: "401" } }],
      }),
    );
    expect(terminal).toMatchObject({ type: "failed", retryable: false });
  });

  it("a thrown error is read for .status / .statusCode / .cause.code", () => {
    expect(errorToTerminal(Object.assign(new Error("x"), { status: 500 }))).toMatchObject({ retryable: true });
    expect(errorToTerminal(Object.assign(new Error("x"), { statusCode: 400 }))).toMatchObject({ retryable: false });
    expect(errorToTerminal(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } }))).toMatchObject({
      retryable: true,
    });
    expect(errorToTerminal(new Error("plain failure"))).toMatchObject({ retryable: false });
  });
});

describe("thinking: what is published, live and read back", () => {
  const message = (content: unknown[]) => ({ role: "assistant", content }) as unknown as AssistantMessage;
  const readable = { type: "thinking", thinking: "because" };
  // As pi's Bedrock path streams encrypted reasoning: the block is flagged before its placeholder delta is pushed.
  const redacted = { type: "thinking", thinking: "[Reasoning redacted]", redacted: true };

  it("streams a delta only into a readable block, and reads back only readable blocks, joined as streamed", () => {
    const partial = message([readable, redacted]);
    expect(streamsThinkingDelta({ contentIndex: 0, partial })).toBe(true);
    expect(streamsThinkingDelta({ contentIndex: 1, partial })).toBe(false);
    expect(answerThinking(message([readable, { type: "text", text: "so" }, readable, redacted]))).toBe(
      "becausebecause",
    );
    expect(answerThinking(message([redacted, { type: "text", text: "so" }]))).toBeUndefined();
  });

  it("the observation plane drops a redacted block's placeholder delta and streams a readable one", () => {
    const partial = message([readable, redacted]);
    const delta = (contentIndex: number, text: string) =>
      toSessionEvent(
        {
          type: "message_update",
          message: partial,
          assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: text, partial },
        } as unknown as AgentSessionEvent,
        "run",
      );
    expect(delta(0, "because")).toMatchObject({
      type: "message_delta",
      data: { channel: "thinking", delta: "because" },
    });
    expect(delta(1, "[Reasoning redacted]")).toBeNull();
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

describe("toPiPromptOptions: a queued image pi cannot resize is sent as given, and said", () => {
  it("resizes what it can decode; keeps what it cannot, with a warning naming the image", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const garbage = Buffer.from("not an image").toString("base64");
    const said: string[] = [];
    const warn = vi.spyOn(log, "warn").mockImplementation((message: string) => void said.push(message));
    try {
      const out = await toPiPromptOptions(
        {
          text: "look",
          images: [
            { data: png, mimeType: "image/png" },
            { data: garbage, mimeType: "image/png" },
          ],
        },
        "queued",
      );
      expect(out?.images?.map((image) => image.data)).toEqual([png, garbage]);
      expect(said).toEqual([expect.stringContaining("queued image 2 (image/png) could not be resized")]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("tool_progress: an outer call's status line, sent when it changes", () => {
  const at = { timestamp: 0, runId: "r" };
  const started = (id: string, name: string, args: Json, parentToolCallId?: string) => ({
    ...at,
    type: "tool_started",
    data: { id, name, args, ...(parentToolCallId ? { parentToolCallId } : {}) },
  });
  const progress = (id: string, text: string, parentToolCallId?: string) => ({
    ...at,
    type: "tool_progress",
    data: {
      id,
      name: "t",
      partialResult: { content: text ? [{ type: "text", text }] : [] },
      ...(parentToolCallId ? { parentToolCallId } : {}),
    },
  });

  it("is the last visible line, untruncated: a bare \\r ends a line, terminal control sequences are not text", () => {
    const project = agentEventProjection();
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
      null,
      { type: "tool_progress", id: "t1", text: "line two" },
      null,
      { type: "tool_progress", id: "t1", text: "downloading 60%" },
      { type: "tool_progress", id: "t1", text: "PASS 42 passed" },
      { type: "tool_progress", id: "t1", text: long },
    ]);
  });

  it("reports a nested call starting as its outer call's status, at any depth; a nested call's own output is not", () => {
    const project = agentEventProjection();
    expect(project(started("outer", "codemode", { code: "..." }))).toMatchObject({ type: "tool_started" });
    expect(project(started("outer/1", "weather", { city: "London\nUK", days: 3 }, "outer"))).toEqual({
      type: "tool_progress",
      id: "outer",
      text: "weather London UK",
    });
    expect(project(started("outer/1/1", "fetch", {}, "outer/1"))).toEqual({
      type: "tool_progress",
      id: "outer",
      text: "fetch",
    });
    expect(project(progress("outer/1/1", "downloaded 3 MB", "outer/1"))).toBeNull();
    // An unchanged line is not sent again, whoever set it; the outer call's own new line replaces it.
    expect(project(progress("outer", "fetch"))).toBeNull();
    expect(project(progress("outer", "summarizing"))).toEqual({
      type: "tool_progress",
      id: "outer",
      text: "summarizing",
    });
  });
});
