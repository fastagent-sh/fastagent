/**
 * `retryable` classification — the one bit every SPEC failure carries, and the reason a channel
 * either retries or reports. Structured status/code first, prose only as the last-resort ceiling.
 */
import { describe, expect, it } from "vitest";
import { classifyRetryable, errorToTerminal, toTerminal } from "../src/engines/pi/turn-kit.ts";

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

describe("terminals read the engine's own signal", () => {
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
