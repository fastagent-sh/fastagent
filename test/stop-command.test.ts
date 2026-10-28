/** A chat's stop command over the agent's `sessions.cancel`: what it stopped, said in the chat. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentError } from "../src/agent-api.ts";
import { dispatchStop } from "../src/channels/kit/stop-command.ts";
import { newSession } from "../src/conversation-sessions.ts";
import { durableSubject } from "./durable-subject.ts";
import { scriptedAgent, withStop } from "./scripted-agent.ts";

const subject = durableSubject();
afterEach(async () => {
  vi.restoreAllMocks();
  await subject.stop();
});

describe("dispatchStop", () => {
  it("stops the running message and says so; then says nothing is running", async () => {
    const agent = await subject.start();
    const sessionId = await newSession(agent);
    const sent = await agent.messages.send({ sessionId, content: "hold" });
    await vi.waitFor(() => expect(subject.held()).toBe(1));
    expect(await dispatchStop(agent, sessionId, "[test]")).toBe("⏹ Stopped.");
    // The stop is answered once it is recorded; the message ends after.
    expect(await agent.messages.get({ sessionId, messageId: sent.id }, { wait: 30 })).toMatchObject({
      status: "canceled",
    });
    expect(await dispatchStop(agent, sessionId, "[test]")).toBe("Nothing is running.");
    // A place nothing was said in has no session.
    expect(await dispatchStop(agent, undefined, "[test]")).toBe("Nothing is running.");
  });

  it("says it cannot tell when the stop may have been recorded, and that it could not stop when it was refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = (error: unknown) =>
      dispatchStop(
        withStop(
          scriptedAgent(() => []),
          () => {
            throw error;
          },
        ),
        "s",
        "[test]",
      );
    const unknown = "⚠️ Could not tell whether it stopped — check again in a moment.";
    expect(await failing(agentError("unavailable", "the disk is gone"))).toBe(unknown);
    expect(await failing(new Error("the connection dropped"))).toBe(unknown);
    expect(await failing(agentError("internal", "the stop was not recorded"))).toBe("⚠️ Could not stop (internal).");
    expect(await failing(agentError("not_found", "No session s"))).toBe("Nothing is running.");
  });
});
