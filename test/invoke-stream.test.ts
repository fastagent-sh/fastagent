import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import { runInvokeStream } from "../src/cli/invoke-stream.ts";

async function* stream(...events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
}
/** Capture the two sinks runInvokeStream writes to (out = reply text, err = diagnostics). */
function sinks() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, outFn: (s: string) => out.push(s), errFn: (s: string) => err.push(s) };
}

describe("runInvokeStream", () => {
  it("streams text to out and exits 0 on completed (err stays empty)", async () => {
    const s = sinks();
    const code = await runInvokeStream(
      stream({ type: "text", delta: "Red, " }, { type: "text", delta: "blue" }, { type: "completed" }),
      s.outFn,
      s.errFn,
    );
    expect(code).toBe(0);
    expect(s.out.join("")).toBe("Red, blue");
    expect(s.err).toEqual([]);
  });

  it("a failed turn exits 1 with the reason on err — the CI-gating guarantee", async () => {
    const s = sinks();
    const code = await runInvokeStream(
      stream({ type: "text", delta: "hmm" }, { type: "failed", details: "boom", retryable: true }),
      s.outFn,
      s.errFn,
    );
    expect(code).toBe(1);
    expect(s.err.join("\n")).toMatch(/failed: boom \(retryable\)/);
    expect(s.out.join("")).toBe("hmm"); // text still went to out, never err
  });

  it("a tool that errors inside a completed turn surfaces on err, by name", async () => {
    const s = sinks();
    const code = await runInvokeStream(
      stream(
        { type: "tool_started", id: "t1", name: "lookup", args: {} },
        { type: "tool_ended", id: "t1", isError: true, content: "404" },
        { type: "completed" },
      ),
      s.outFn,
      s.errFn,
    );
    expect(code).toBe(0); // the TURN completed — only the tool errored
    expect(s.err.join("\n")).toMatch(/\[tool\] lookup/); // started
    expect(s.err.join("\n")).toMatch(/lookup failed/); // and its error, named from the matching tool_started
  });

  it("a successful tool is not reported as a failure", async () => {
    const s = sinks();
    await runInvokeStream(
      stream(
        { type: "tool_started", id: "t1", name: "lookup", args: {} },
        { type: "tool_ended", id: "t1", isError: false, content: "ok" },
        { type: "completed" },
      ),
      s.outFn,
      s.errFn,
    );
    expect(s.err.join("\n")).not.toMatch(/failed/);
  });
});
