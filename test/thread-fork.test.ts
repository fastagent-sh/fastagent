/** Where a new thread starts from: a fork of the session that holds the exchange it was opened on, at that ask. */
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
const thread = async (agent: Agent, room: string, ask: string) =>
  forkedSession(agent, await threadForkSource(agent, room, ask));

describe("threadForkSource", () => {
  it("forks at the answer of the ask it names, not at the session's present", async () => {
    const { agent, room } = await roomWith([
      ["m1", "first"],
      ["m2", "second"],
      ["m3", "third"],
    ]);
    expect(await said(agent, await thread(agent, room, "m2"))).toEqual(["first", "second"]);
  });

  it("starts empty when the session is unknown or never held the ask", async () => {
    const { agent, room } = await roomWith([["m1", "first"]]);
    expect(await threadForkSource(agent, room, "never-sent")).toBeUndefined();
    expect(await threadForkSource(agent, undefined, "m1")).toBeUndefined();
  });

  it("says a failure to tell instead of starting empty", async () => {
    const agent = scriptedAgent(() => []);
    const failing = { ...agent, messages: { ...agent.messages, get: async () => Promise.reject(new Error("down")) } };
    await expect(threadForkSource(failing, "room", "m1")).rejects.toThrow("down");
  });

  it("a message without an answer forks at its own entry; a queued one at the present", async () => {
    const source = async (message: Message) => {
      const agent = scriptedAgent(() => []);
      return threadForkSource({ ...agent, messages: { ...agent.messages, get: async () => message } }, "room", "m1");
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
