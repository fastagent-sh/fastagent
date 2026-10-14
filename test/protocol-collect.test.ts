import { describe, expect, it } from "vitest";
import { loopPort } from "../src/loop-port.ts";
import { collect, RunNotCompleted, RunUnfinished } from "../src/protocol-collect.ts";
import { AgentRejection, type InvokeEvent } from "../src/protocol.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { FakeStore, fakeLoopHarness } from "./fake-loop-harness.ts";

const agent = servingAgent(loopPort(fakeLoopHarness(new FakeStore())));

async function* upTo(events: AsyncIterable<InvokeEvent>, kind: string): AsyncIterable<InvokeEvent> {
  for await (const event of events) {
    if (event.type === "entry" && event.entry.kind === kind) return;
    yield event;
  }
}

describe("collect (v1)", () => {
  it("answers a completed run's last assistant text", async () => {
    expect(await collect(agent.invoke({ sessionId: "a", prompt: { text: "hi" } }))).toMatchObject({
      sessionId: "a",
      text: "answer: hi",
    });
  });

  it("throws why there is no answer: rejected, not completed, or never ended", async () => {
    await expect(collect(agent.invoke({ sessionId: "", prompt: { text: "hi" } }))).rejects.toBeInstanceOf(
      AgentRejection,
    );
    await expect(collect(agent.invoke({ sessionId: "b", prompt: { text: "fail" } }))).rejects.toBeInstanceOf(
      RunNotCompleted,
    );
    await expect(collect(upTo(agent.invoke({ sessionId: "c", prompt: { text: "hi" } }), "run_ended"))).rejects.toThrow(
      RunUnfinished,
    );
  });
});
