import { afterEach, describe, expect, it, vi } from "vitest";
import { type TelegramUpdate, telegramChannel } from "../src/telegram.ts";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/index.ts";

/** A faux Agent that records invocations and replies with `reply` text (contract-only). */
function replyingAgent(reply = "") {
  const calls: { session: string; text: string }[] = [];
  const agent: Agent = {
    async *invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      calls.push({ session: scope.session, text: prompt.text });
      if (reply !== "") yield { type: "text", delta: reply };
      yield { type: "completed" };
    },
  };
  return { agent, calls };
}

/** Let fire-and-forget turns (started after the 200) run to completion before asserting. */
const flush = () => new Promise((r) => setImmediate(r));

const SECRET = "tg-secret";
const API = "http://tg.test";

function tgRequest(update: unknown, opts: { secret?: string } = {}): Request {
  return new Request("http://app/telegram", {
    method: "POST",
    body: JSON.stringify(update),
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": opts.secret ?? SECRET },
  });
}

const MSG: TelegramUpdate = { update_id: 5, message: { message_id: 1, text: "hi", chat: { id: 42, type: "private" } } };
const echoOn = (u: TelegramUpdate) => {
  const m = u.message;
  return m?.text ? [{ session: `${m.chat.id}`, text: m.text, chatId: m.chat.id }] : [];
};

afterEach(() => vi.unstubAllGlobals());

describe("telegram channel", () => {
  it("rejects non-POST with 405", async () => {
    const { agent } = replyingAgent();
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "B", on: () => [] });
    expect((await ch(new Request("http://app/telegram", { method: "GET" }))).status).toBe(405);
  });

  it("refuses an empty secretToken / botToken at construction", () => {
    const { agent } = replyingAgent();
    expect(() => telegramChannel(agent, { secretToken: "", botToken: "B", on: () => [] })).toThrow(/secretToken/);
    expect(() => telegramChannel(agent, { secretToken: SECRET, botToken: "", on: () => [] })).toThrow(/botToken/);
  });

  it("rejects a missing/wrong secret token with 401 and never routes", async () => {
    const { agent } = replyingAgent();
    let routed = false;
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "B",
      on: () => {
        routed = true;
        return [];
      },
    });
    expect((await ch(tgRequest(MSG, { secret: "wrong" }))).status).toBe(401);
    expect((await ch(new Request("http://app/telegram", { method: "POST", body: "{}" }))).status).toBe(401); // no header
    expect(routed).toBe(false);
  });

  it("rejects an oversized body with 413 before parsing", async () => {
    const { agent } = replyingAgent();
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "B", on: () => [] });
    const big = new Request("http://app/telegram", {
      method: "POST",
      body: "x".repeat((1 << 20) + 1),
      headers: { "x-telegram-bot-api-secret-token": SECRET },
    });
    expect((await ch(big)).status).toBe(413);
  });

  it("a verified body that isn't JSON is 400", async () => {
    const { agent } = replyingAgent();
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "B", on: () => [] });
    const bad = new Request("http://app/telegram", {
      method: "POST",
      body: "not json{",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
    });
    expect((await ch(bad)).status).toBe(400);
  });

  it("routes a verified update, invokes the agent, and sends the reply to the chat (model A)", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("hello back");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: echoOn, apiBaseUrl: API });

    const res = await ch(tgRequest(MSG));
    expect(res.status).toBe(200); // ACK immediately
    await flush();

    expect(calls).toEqual([{ session: "42", text: "hi" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/botBOT/sendMessage`);
    expect(JSON.parse(String(init.body))).toMatchObject({ chat_id: 42, text: "hello back" });
  });

  it("does not call sendMessage when the agent reply is empty", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent(""); // completes with no text
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: echoOn, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an update the routing ignores acks 200 and never invokes", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("x");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: () => [], apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(calls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a turn that fails after the 200 is caught + logged, not unhandled", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "failed", details: "boom", retryable: false };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: echoOn, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(errors.some((e) => /turn failed: turn=5#0 session=42/.test(e) && /boom/.test(e))).toBe(true);
    spy.mockRestore();
  });
});
