import { describe, expect, it } from "vitest";
import { logAgentLoop } from "../src/observe.ts";
import { loopPort } from "../src/loop-port.ts";
import type { InvokeEvent } from "../src/protocol.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { FakeStore, fakeLoopHarness } from "./fake-loop-harness.ts";

async function drain(it: AsyncIterable<InvokeEvent>): Promise<InvokeEvent[]> {
  const out: InvokeEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("logAgentLoop", () => {
  it("traces prompt, tool result, reply and outcome, and passes events through unchanged", async () => {
    const lines: string[] = [];
    const agent = servingAgent(loopPort(fakeLoopHarness(new FakeStore())));
    const wrapped = logAgentLoop(agent, (l) => lines.push(l));
    const passed = await drain(wrapped.invoke({ sessionId: "s1", prompt: { text: "effect" } }));
    const plain = await drain(agent.invoke({ sessionId: "s2", prompt: { text: "effect" } }));
    expect(passed.map((e) => e.type)).toEqual(plain.map((e) => e.type));
    expect(lines.some((l) => /message session=s1/.test(l) && /effect/.test(l))).toBe(true);
    expect(lines.some((l) => /tool ✓ effect/.test(l))).toBe(true);
    expect(lines.some((l) => /reply: answer: effect/.test(l))).toBe(true);
    expect(lines.some((l) => /■ completed/.test(l))).toBe(true);
  });

  it("traces a failed message with its error", async () => {
    const lines: string[] = [];
    const wrapped = logAgentLoop(servingAgent(loopPort(fakeLoopHarness(new FakeStore()))), (l) => lines.push(l));
    await drain(wrapped.invoke({ sessionId: "s", prompt: { text: "fail" } }));
    expect(lines.some((l) => /■ failed: model_error: boom/.test(l))).toBe(true);
  });
});
