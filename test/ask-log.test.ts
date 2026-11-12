import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError, type Message, agentError } from "../src/agent-api.ts";
import { createAskLog } from "../src/channels/kit/ask-log.ts";
import { log } from "../src/log.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The Agent's messages of one session, by key: what each ask became. */
function agentWith(held: Record<string, Partial<Message> | "missing" | Error>) {
  const asked: string[] = [];
  const messages = {
    async get(key: { sessionId: string; idempotencyKey?: string }): Promise<Message> {
      const idempotencyKey = (key as { idempotencyKey: string }).idempotencyKey;
      asked.push(idempotencyKey);
      const found = held[idempotencyKey];
      if (found === undefined || found === "missing") throw agentError("not_found", "no such message");
      if (found instanceof Error) throw found;
      return {
        id: `m-${idempotencyKey}`,
        sessionId: key.sessionId,
        idempotencyKey,
        status: "completed",
        ...found,
      } as Message;
    },
  };
  return { messages: messages as never, asked };
}

function setup(held: Record<string, Partial<Message> | "missing" | Error> = {}, maxConversations?: number) {
  const root = mkdtempSync(join(tmpdir(), "ask-log-"));
  roots.push(root);
  const path = join(root, "asks.json");
  const agent = agentWith(held);
  const open = () =>
    createAskLog<number>({
      label: "[test]",
      path,
      messages: agent.messages,
      isPosition: (value): value is number => typeof value === "number",
      compare: (a, b) => a - b,
      ...(maxConversations === undefined ? {} : { maxConversations }),
    });
  return { asks: open(), open, path, agent };
}

describe("ask log: where a conversation's session read to", () => {
  it("is the newest earlier ask the Agent holds", async () => {
    const { asks, agent } = setup({ a: { entryId: "e1" }, b: { entryId: "e2" } });
    asks.record("c", { key: "a", at: 10 });
    asks.record("c", { key: "b", at: 20 });
    expect(await asks.readTo("c", "s", 30)).toBe(20);
    expect(agent.asked).toEqual(["b"]); // the newest answers; older ones are not asked about
  });

  it("only counts asks before the one being read for, so a replayed turn does not start at itself", async () => {
    const { asks } = setup({ a: { entryId: "e1" }, b: { entryId: "e2" } });
    asks.record("c", { key: "a", at: 10 });
    asks.record("c", { key: "b", at: 20 });
    expect(await asks.readTo("c", "s", 20)).toBe(10);
    expect(await asks.readTo("c", "s", 10)).toBeUndefined();
  });

  it("has no start without a session, or when the Agent holds none of the asks", async () => {
    const { asks, agent } = setup({ a: "missing" });
    asks.record("c", { key: "a", at: 10 });
    expect(await asks.readTo("c", undefined, 20)).toBeUndefined();
    expect(agent.asked).toEqual([]); // no session, nothing to ask
    expect(await asks.readTo("c", "s", 20)).toBeUndefined(); // sent into no session: it failed first
    expect(await asks.readTo("other", "s", 20)).toBeUndefined();
  });

  it("skips an ask that was never sent for the one before it", async () => {
    const { asks } = setup({ a: { entryId: "e1" }, b: "missing" });
    asks.record("c", { key: "a", at: 10 });
    asks.record("c", { key: "b", at: 20 });
    expect(await asks.readTo("c", "s", 30)).toBe(10);
  });

  it("counts an ask still waiting and one the agent took, but not one withdrawn or refused before it was taken", async () => {
    const waiting = setup({ a: { status: "queued" } });
    waiting.asks.record("c", { key: "a", at: 10 });
    expect(await waiting.asks.readTo("c", "s", 20)).toBe(10); // the agent will take it

    const taken = setup({ a: { status: "failed", entryId: "e1" } });
    taken.asks.record("c", { key: "a", at: 10 });
    expect(await taken.asks.readTo("c", "s", 20)).toBe(10); // its text is in the session whatever became of the run

    const withdrawn = setup({ a: { entryId: "e0" }, b: { status: "canceled" } });
    withdrawn.asks.record("c", { key: "a", at: 10 });
    withdrawn.asks.record("c", { key: "b", at: 20 });
    expect(await withdrawn.asks.readTo("c", "s", 30)).toBe(10); // b was withdrawn without an entry

    const refused = setup({ a: { entryId: "e0" }, b: { status: "failed" } });
    refused.asks.record("c", { key: "a", at: 10 });
    refused.asks.record("c", { key: "b", at: 20 });
    expect(await refused.asks.readTo("c", "s", 30)).toBe(10); // b failed before the agent took it
  });

  it("rejects when the Agent cannot say, rather than guessing a start", async () => {
    const failure = new AgentError(agentError("unavailable", "storage is down"));
    const { asks } = setup({ a: failure });
    asks.record("c", { key: "a", at: 10 });
    await expect(asks.readTo("c", "s", 20)).rejects.toBe(failure);
  });

  it("keeps an ask once, however often it is recorded, in the order of its place", async () => {
    const { asks, agent } = setup({ a: { entryId: "e1" }, b: { entryId: "e2" } });
    asks.record("c", { key: "b", at: 20 });
    asks.record("c", { key: "a", at: 10 }); // arrives out of order
    asks.record("c", { key: "b", at: 20 }); // redelivered
    expect(await asks.readTo("c", "s", 30)).toBe(20);
    expect(agent.asked).toEqual(["b"]);
  });

  it("reads from the newest ask with no upper bound, as a room's first read for a thread does", async () => {
    const { asks } = setup({ a: { entryId: "e1" }, b: { entryId: "e2" } });
    asks.record("c", { key: "a", at: 10 });
    asks.record("c", { key: "b", at: 20 });
    expect(await asks.readTo("c", "s")).toBe(20);
  });

  it("forgets an ask whose read failed, so the ask before it is where the session read to", async () => {
    const { asks, open } = setup({ a: { entryId: "e1" }, b: { entryId: "e2" } });
    asks.record("c", { key: "a", at: 10 });
    asks.record("c", { key: "b", at: 20 });
    asks.forget("c", "b");
    asks.forget("c", "never-asked"); // nothing to forget
    expect(await asks.readTo("c", "s", 30)).toBe(10);
    expect(await open().readTo("c", "s", 30)).toBe(10); // and it stays forgotten
  });

  it("survives a restart", async () => {
    const { asks, open } = setup({ a: { entryId: "e1" } });
    asks.record("c", { key: "a", at: 10 });
    expect(await open().readTo("c", "s", 20)).toBe(10);
  });

  it("bounds the asks a conversation keeps and the conversations it keeps", async () => {
    const held: Record<string, Partial<Message>> = {};
    for (let i = 0; i < 10; i++) held[`k${i}`] = { entryId: `e${i}` };
    const { asks, agent } = setup(held, 10);
    for (let i = 0; i < 10; i++) asks.record("c", { key: `k${i}`, at: i });
    for (let i = 0; i < 10; i++) asks.record(`other-${i}`, { key: "x", at: 1 });
    expect(await asks.readTo("c", "s", 100)).toBeUndefined(); // c is the least recent conversation: dropped
    asks.record("c", { key: "k9", at: 9 });
    agent.asked.length = 0;
    expect(await asks.readTo("c", "s", 100)).toBe(9);
  });

  it("says where an ask stands while it is among the newest, and nothing once it is not", () => {
    const { asks } = setup({});
    for (let i = 0; i < 8; i++) asks.record("c", { key: `k${i}`, at: i });
    expect(asks.positionOf("c", "k7")).toBe(7);
    expect(asks.positionOf("c", "k0")).toBeUndefined(); // past the newest few the log keeps
    expect(asks.positionOf("other", "k7")).toBeUndefined();
  });

  it("says a write that failed, and still answers from memory", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const { asks, path } = setup({ a: { entryId: "e1" } });
    mkdirSync(`${path}.tmp`); // the atomic write now fails
    asks.record("c", { key: "a", at: 10 });
    expect(warn.mock.calls.flat().join(" ")).toContain("could not write");
    expect(await asks.readTo("c", "s", 20)).toBe(10);
  });

  it("starts empty, and says so, from a file of the wrong shape", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const { open, path } = setup({ a: { entryId: "e1" } });
    writeFileSync(path, JSON.stringify({ c: [{ key: "a", at: "not a position" }] }));
    expect(await open().readTo("c", "s", 20)).toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toContain("unexpected shape");
  });
});
