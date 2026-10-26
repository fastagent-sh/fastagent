import { describe, expect, it } from "vitest";
import { runInvokeStream } from "../src/cli/invoke-stream.ts";
import type { Json, Outcome, SessionEvent } from "../src/agent-api.ts";
import type { StreamResult } from "../src/agent-api-stream.ts";

type InvokeEvent = SessionEvent;
const messageId = "m1";
let n = 0;
const entry = (kind: string, data: Json): InvokeEvent => ({
  type: "entry",
  entry: { id: `e${++n}`, sessionId: "s", timestamp: 0, kind, data },
});
const delta = (text: string): InvokeEvent => ({ type: "message_delta", channel: "text", delta: text });
const started = (id: string, name: string, args: Json = {}): InvokeEvent => ({
  type: "tool_started",
  toolCallId: id,
  name,
  args,
});
const progress = (id: string, text: string): InvokeEvent => ({ type: "tool_progress", toolCallId: id, text });
const result = (id: string, isError: boolean) => entry("tool_result", { toolCallId: id, isError, text: "" });
const ended = (outcome: Outcome = { status: "completed" }): InvokeEvent => ({
  type: "done",
  message: { messageId, status: "done", outcome },
});

/** A message accepted, then `events` as its session writes them. */
function stream(...events: InvokeEvent[]): StreamResult {
  return {
    ok: true,
    sessionId: "s",
    message: { messageId, status: "queued", position: 0 },
    duplicate: false,
    events: (async function* () {
      yield* events;
    })(),
  };
}
/** Capture the two sinks runInvokeStream writes to (out = reply text, err = diagnostics). */
function sinks() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, outFn: (s: string) => out.push(s), errFn: (s: string) => err.push(s) };
}

describe("runInvokeStream", () => {
  it("streams text to out and exits 0 on a completed run (err stays empty)", async () => {
    const s = sinks();
    const code = await runInvokeStream(stream(delta("Red, "), delta("blue"), ended()), s.outFn, s.errFn);
    expect(code).toBe(0);
    expect(s.out.join("")).toBe("Red, blue");
    expect(s.err).toEqual([]);
  });

  it("a run whose answer arrives as an entry only (no deltas) still prints it", async () => {
    const s = sinks();
    await runInvokeStream(stream(entry("assistant_message", { text: "late" }), ended()), s.outFn, s.errFn);
    expect(s.out.join("")).toBe("late");
  });

  it("a failed run exits 1 with the reason on err — the CI-gating guarantee", async () => {
    const s = sinks();
    const error = { code: "model_error", message: "boom", retryable: true };
    const code = await runInvokeStream(stream(delta("hmm"), ended({ status: "failed", error })), s.outFn, s.errFn);
    expect(code).toBe(1);
    expect(s.err.join("\n")).toMatch(/failed: model_error: boom \(retryable\)/);
    expect(s.out.join("")).toBe("hmm"); // text still went to out, never err
  });

  it("a refusal, an unknown receipt and a stream that ends before its message each exit 1, saying which", async () => {
    const s = sinks();
    const rejected: StreamResult = { ok: false, error: { code: "busy", message: "busy", retryable: true } };
    expect(await runInvokeStream(rejected, s.outFn, s.errFn)).toBe(1);
    expect(await runInvokeStream({ ok: false, unknown: { reason: "the disk is gone" } }, s.outFn, s.errFn)).toBe(1);
    expect(await runInvokeStream(stream(delta("x")), s.outFn, s.errFn)).toBe(1);
    expect(s.err.join("\n")).toMatch(/rejected: busy/);
    expect(s.err.join("\n")).toMatch(/whether the message was taken is not known: the disk is gone/);
    expect(s.err.join("\n")).toMatch(/ended before the message did/);
  });

  it("a tool that errors inside a completed run surfaces on err, by name", async () => {
    const s = sinks();
    const code = await runInvokeStream(stream(started("t1", "lookup"), result("t1", true), ended()), s.outFn, s.errFn);
    expect(code).toBe(0); // the RUN completed — only the tool errored
    expect(s.err.join("\n")).toMatch(/\[tool\] lookup/); // started
    expect(s.err.join("\n")).toMatch(/lookup failed/); // and its error, named from the matching tool_started
  });

  it("a running tool's progress goes to err, by name, never to out", async () => {
    const s = sinks();
    await runInvokeStream(
      stream(started("t1", "bash", { command: "npm test" }), progress("t1", "42 passed"), result("t1", false), ended()),
      s.outFn,
      s.errFn,
    );
    expect(s.err).toEqual(["[tool] bash", "[tool] bash \u203a 42 passed"]);
    expect(s.out).toEqual([]);
  });

  it("clips a long status line at a code-point boundary", async () => {
    const s = sinks();
    const snakes = "\u{1F40D}".repeat(119);
    await runInvokeStream(
      stream(
        started("t1", "bash"),
        progress("t1", `${snakes}ab${"x".repeat(50_000)}`),
        progress("t1", `${snakes}a`), // exactly the width: kept whole
        ended(),
      ),
      s.outFn,
      s.errFn,
    );
    expect(s.err.slice(1)).toEqual([`[tool] bash \u203a ${snakes}a\u2026`, `[tool] bash \u203a ${snakes}a`]);
  });

  it("a successful tool is not reported as a failure", async () => {
    const s = sinks();
    await runInvokeStream(stream(started("t1", "lookup"), result("t1", false), ended()), s.outFn, s.errFn);
    expect(s.err.join("\n")).not.toMatch(/failed/);
  });
});
