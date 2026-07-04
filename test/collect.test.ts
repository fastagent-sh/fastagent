import { describe, expect, it } from "vitest";
import { AgentFailure, collect, type AgentEvent } from "../src/index.ts";

async function* stream(...events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of events) yield e;
}

describe("collect (buffered consumption)", () => {
  it("concatenates text events and returns {text, data} on completed", async () => {
    const result = await collect(
      stream(
        { type: "text", delta: "hello " },
        { type: "text", delta: "world" },
        { type: "completed", data: { ok: true } },
      ),
    );
    expect(result).toEqual({ text: "hello world", data: { ok: true } });
  });

  it("failed terminal throws AgentFailure with details/retryable", async () => {
    await expect(
      collect(stream({ type: "text", delta: "x" }, { type: "failed", details: "boom", retryable: true })),
    ).rejects.toMatchObject({ name: "AgentFailure", details: "boom", retryable: true });
    expect(AgentFailure).toBeTypeOf("function");
  });

  it("missing terminal event throws (MUST 1 violation)", async () => {
    await expect(collect(stream({ type: "text", delta: "x" }))).rejects.toThrow(/terminal/);
  });
});
