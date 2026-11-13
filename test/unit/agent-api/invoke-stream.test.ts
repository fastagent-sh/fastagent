import { describe, expect, it } from "vitest";
import { runInvokeStream } from "../../../src/cli/invoke-stream.ts";
import type { AgentErrorData, MessageStreamEvent } from "../../../src/agent-api.ts";

type InvokeEvent = MessageStreamEvent;
type Ending = { status: "completed" | "incomplete" | "canceled" } | { status: "failed"; error: AgentErrorData };
const id = "m1";
const message = { id, sessionId: "s", status: "queued" } as const;
const delta = (text: string): InvokeEvent => ({ type: "delta", channel: "text", text });
const ended = (ending: Ending = { status: "completed" }): InvokeEvent => ({
  type: "done",
  message: { id, sessionId: "s", ...ending },
});

/** A message recorded, then `events` as its session writes them. */
function stream(...events: InvokeEvent[]): AsyncIterable<MessageStreamEvent> {
  return (async function* () {
    yield { type: "message", message };
    yield* events;
  })();
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

  it("a failed run exits 1 with the reason on err — the CI-gating guarantee", async () => {
    const s = sinks();
    const error = { code: "model_error", message: "boom", retryable: true };
    const code = await runInvokeStream(stream(delta("hmm"), ended({ status: "failed", error })), s.outFn, s.errFn);
    expect(code).toBe(1);
    expect(s.err.join("\n")).toMatch(/failed: model_error: boom \(retryable\)/);
    expect(s.out.join("")).toBe("hmm"); // text still went to out, never err
  });
});
