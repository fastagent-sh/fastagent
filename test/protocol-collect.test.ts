import { describe, expect, it } from "vitest";
import { loopPort } from "../src/loop-port.ts";
import { collect, MessageNotCompleted, MessageUnfinished } from "../src/protocol-collect.ts";
import { AgentRejection, type InvokeEvent } from "../src/protocol.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { FakeStore, fakeLoopHarness } from "./fake-loop-harness.ts";

const agent = servingAgent(loopPort(fakeLoopHarness(new FakeStore())));

async function* untilDone(events: AsyncIterable<InvokeEvent>): AsyncIterable<InvokeEvent> {
  for await (const event of events) {
    if (event.type === "done") return;
    yield event;
  }
}

describe("collect (v1)", () => {
  it("answers a completed message's answer", async () => {
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
      MessageNotCompleted,
    );
    await expect(collect(untilDone(agent.invoke({ sessionId: "c", prompt: { text: "hi" } })))).rejects.toThrow(
      MessageUnfinished,
    );
  });
});
