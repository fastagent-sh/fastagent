/** Where a new thread starts from: a fork of its room at the message its reply chain names. */
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Message } from "../src/agent-api.ts";
import { threadForkSource } from "../src/channels/kit/thread-fork.ts";
import { forkedSession, newSession } from "../src/conversation-sessions.ts";
import { durableSubject } from "./durable-subject.ts";
import { scriptedAgent } from "./scripted-agent.ts";

const subject = durableSubject();
afterEach(() => subject.stop());

/** A room where each ask was sent under its key and answered. */
const roomWith = async (asks: [key: string, text: string][]) => {
  const agent = await subject.start();
  const room = await newSession(agent);
  for (const [idempotencyKey, text] of asks) {
    await agent.messages.send({ sessionId: room, idempotencyKey, content: text }, { wait: 30 });
  }
  return { agent, room };
};

const said = async (agent: Agent, sessionId: string) => {
  const page = await agent.sessions.entries(sessionId);
  return page.data
    .filter((e) => e.kind === "user")
    .map((e) => (e.data as { content: { text: string }[] }).content[0]?.text);
};

/** A thread's session as a channel's `sessionFor` makes it: forked from what `threadForkSource` answers. */
const thread = async (agent: Agent, room: string, chain: readonly string[]) =>
  forkedSession(agent, await threadForkSource(agent, room, chain));

describe("threadForkSource", () => {
  it("forks at the answer of the first message its chain names, nearest first", async () => {
    const { agent, room } = await roomWith([
      ["m1", "first"],
      ["m2", "second"],
      ["m3", "third"],
    ]);
    // "card" is no message the channel sent with (the agent posted it), so the next one up names one.
    expect(await said(agent, await thread(agent, room, ["card", "m2", "m1"]))).toEqual(["first", "second"]);
  });

  it("forks at the room's present when nothing in its chain names a message", async () => {
    const { agent, room } = await roomWith([
      ["m1", "first"],
      ["m2", "second"],
    ]);
    expect(await said(agent, await thread(agent, room, ["someone-else"]))).toEqual(["first", "second"]);
  });

  it("a message without an answer forks at its own entry; a queued one at the present", async () => {
    const source = async (message: Message) => {
      const agent = scriptedAgent(() => []);
      return threadForkSource({ ...agent, messages: { ...agent.messages, get: async () => message } }, "room", ["m1"]);
    };
    expect(await source({ id: "m", sessionId: "room", entryId: "asked", status: "running" })).toEqual({
      sessionId: "room",
      entryId: "asked",
    });
    expect(await source({ id: "m", sessionId: "room", entryId: "asked", status: "failed" })).toEqual({
      sessionId: "room",
      entryId: "asked",
    });
    expect(await source({ id: "m", sessionId: "room", status: "queued" })).toEqual({ sessionId: "room" });
  });
});

describe("forkedSession", () => {
  it("starts empty when there is nothing to fork, since nothing was said there yet", async () => {
    const { agent } = await roomWith([]);
    expect(await said(agent, await forkedSession(agent, undefined))).toEqual([]);
  });

  it("a fork the agent refuses is an error naming its source", async () => {
    await expect(
      forkedSession(
        scriptedAgent(() => []),
        { sessionId: "gone" },
      ),
    ).rejects.toThrow("starting a session forked from gone failed: No session gone");
  });
});
