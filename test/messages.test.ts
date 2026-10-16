/**
 * How fastagent reads pi's messages (messages.ts): whether a failure is worth retrying, read from the harness's own
 * signal (status, code) first and prose only as the last-resort ceiling; what thinking is published; and a queued
 * prompt's images.
 */
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  answerThinking,
  answeredOutcome,
  streamsThinkingDelta,
  thrownFailure,
  toPiPromptOptions,
} from "../src/harnesses/pi/messages.ts";
import { log } from "../src/log.ts";

const thrown = (fields: Record<string, unknown>, message = "x") =>
  thrownFailure(Object.assign(new Error(message), fields));

describe("a thrown error: structured signal first, prose as the ceiling", () => {
  it("a status decides, whatever the prose says", () => {
    expect(thrown({ status: 400 }, "bad request mentioning timeout")).toMatchObject({
      code: "internal",
      retryable: false,
    });
    expect(thrown({ status: 429 })).toMatchObject({ code: "model_error", retryable: true });
    expect(thrown({ status: 503 })).toMatchObject({ code: "model_error", retryable: true });
    expect(thrown({ statusCode: 401 })).toMatchObject({ retryable: false });
  });

  it("a network code decides, on the error or its cause; an unknown one falls through to prose", () => {
    expect(thrown({ code: "ECONNRESET" }).retryable).toBe(true);
    expect(thrown({ cause: { code: "ETIMEDOUT" } }).retryable).toBe(true);
    expect(thrown({ code: "429" }).retryable).toBe(true); // a status carried as a string
    expect(thrown({ code: 503 }).retryable).toBe(true);
    expect(thrown({ code: "ENOENT" }).retryable).toBe(false);
  });

  it("prose is the ceiling, not the classifier", () => {
    expect(thrown({}, "model is overloaded, try again").retryable).toBe(true);
    expect(thrown({}, "request timed out").retryable).toBe(true);
    expect(thrown({}, "invalid api key").retryable).toBe(false);
  });
});

describe("an answer's outcome reads the harness's own signal", () => {
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

  it("an answer pi itself recorded as aborted is a failure: a run the caller stopped is the port's to call canceled", () => {
    expect(answeredOutcome(message({ stopReason: "aborted", errorMessage: "Request aborted" }))).toMatchObject({
      status: "failed",
      error: { code: "internal", message: "Request aborted", retryable: false },
    });
  });

  it("a clean stop is completed, and a cut-off answer still answers", () => {
    expect(answeredOutcome(message({ stopReason: "stop" }))).toEqual({ status: "completed" });
    expect(answeredOutcome(message({ stopReason: "length" }))).toEqual({ status: "max_tokens" });
  });

  it("diagnostics carry the code, and the LAST code-bearing one is the cause", () => {
    expect(
      answeredOutcome(
        message({ stopReason: "error", errorMessage: "upstream", diagnostics: [{ error: { code: "503" } }] }),
      ),
    ).toMatchObject({ status: "failed", error: { code: "model_error", retryable: true } });
    expect(
      answeredOutcome(
        message({
          stopReason: "error",
          errorMessage: "upstream",
          // an earlier transient must not classify a terminal auth failure as retryable
          diagnostics: [{ error: { code: "503" } }, { error: { code: "401" } }],
        }),
      ),
    ).toMatchObject({ status: "failed", error: { code: "model_error", retryable: false } });
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
