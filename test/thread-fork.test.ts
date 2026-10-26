/** Where a new thread starts from: a fork of its room at the message its reply chain names. */
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, MessageStatus } from "../src/agent-api.ts";
import { forkThread } from "../src/channels/kit/thread-fork.ts";
import { newSession } from "../src/conversation-sessions.ts";
import { durableSubject } from "./durable-subject.ts";
import { scriptedAgent } from "./scripted-agent.ts";

const subject = durableSubject();
afterEach(() => subject.stop());

/** A room where each ask was sent under its key and answered. */
const roomWith = async (asks: [key: string, text: string][]) => {
  const agent = await subject.start();
  const room = await newSession(agent);
  for (const [idempotencyKey, text] of asks) {
    const sent = await agent.invoke({ sessionId: room, idempotencyKey, content: [{ type: "text", text }] });
    if (!sent.ok) throw new Error("not sent");
    await sent.wait();
  }
  return { agent, room };
};

const said = async (agent: Agent, sessionId: string) => {
  const page = await agent.read(sessionId);
  if (!page.ok) throw new Error(page.error.message);
  return page.entries
    .filter((e) => e.kind === "user_message")
    .map((e) => (e.data as { content: { text: string }[] }).content[0]?.text);
};

describe("forkThread", () => {
  it("forks at the answer of the first message its chain names, nearest first", async () => {
    const { agent, room } = await roomWith([
      ["m1", "first"],
      ["m2", "second"],
      ["m3", "third"],
    ]);
    // "card" is no message the channel sent with (the agent posted it), so the next one up names one.
    const thread = await forkThread(agent, { room, chain: ["card", "m2", "m1"] });
    expect(await said(agent, thread)).toEqual(["first", "second"]);
  });

  it("forks at the room's present when nothing in its chain names a message", async () => {
    const { agent, room } = await roomWith([
      ["m1", "first"],
      ["m2", "second"],
    ]);
    const thread = await forkThread(agent, { room, chain: ["someone-else"] });
    expect(await said(agent, thread)).toEqual(["first", "second"]);
  });

  it("starts empty when its room has no session, since nothing was said there yet", async () => {
    const { agent } = await roomWith([]);
    const thread = await forkThread(agent, { room: undefined, chain: ["m1"] });
    expect(await said(agent, thread)).toEqual([]);
  });

  it("a message without an answer forks at its own entry; a queued one at the present", async () => {
    const forked = async (message: MessageStatus) => {
      const agent = scriptedAgent(() => []);
      const room = await newSession(agent);
      await forkThread({ ...agent, getMessage: async () => message }, { room, chain: ["m1"] });
      return agent.forks.at(-1);
    };
    expect(await forked({ messageId: "m", entryId: "asked", status: "taken" })).toEqual({
      from: { sessionId: "session-1", entryId: "asked" },
    });
    expect(await forked({ messageId: "m", status: "queued", position: 0 })).toEqual({
      from: { sessionId: "session-1" },
    });
  });

  it("a fork the agent refuses is an error naming the room", async () => {
    const agent = scriptedAgent(() => []);
    await expect(forkThread(agent, { room: "gone", chain: [] })).rejects.toThrow(
      "starting a thread from gone failed: No session gone",
    );
  });
});
