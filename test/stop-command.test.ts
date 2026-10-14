/** A chat's stop command over the agent's `abort`: what it stopped, said in the chat. */
import { describe, expect, it, vi } from "vitest";
import { dispatchStop } from "../src/channels/kit/stop-command.ts";
import { loopPort } from "../src/loop-port.ts";
import { servingAgent } from "../src/serving-layer.ts";
import { FakeStore, fakeLoopHarness } from "./fake-loop-harness.ts";

describe("dispatchStop", () => {
  it("stops the running run and says so; then says nothing is running", async () => {
    const agent = servingAgent(loopPort(fakeLoopHarness(new FakeStore())));
    const first = agent.invoke({ sessionId: "s", prompt: { text: "hold" } })[Symbol.asyncIterator]();
    await first.next();
    await vi.waitFor(async () => {
      const state = await agent.sessions.get("s").read({ limit: 0 });
      expect(state.ok && state.state.status).toBe("running");
    });
    expect(await dispatchStop(agent, "s", "[test]")).toBe("⏹ Stopped.");
    await vi.waitFor(async () => expect(await dispatchStop(agent, "s", "[test]")).toBe("Nothing is running."));
    expect(await dispatchStop(agent, "never-used", "[test]")).toBe("Nothing is running.");
    await first.return?.();
  });
});
