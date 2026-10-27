/** A chat's stop command over the agent's `sessions.cancel`: what it stopped, said in the chat. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchStop } from "../src/channels/kit/stop-command.ts";
import { newSession } from "../src/conversation-sessions.ts";
import { durableSubject } from "./durable-subject.ts";

const subject = durableSubject();
afterEach(() => subject.stop());

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
});
