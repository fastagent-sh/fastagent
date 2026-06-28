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

/** Mirrors the scaffold's auto-adapting on(): per-thread session + reply-in-thread when present. */
const threadOn = (u: TelegramUpdate) => {
  const m = u.message;
  if (!m?.text) return [];
  const session = m.message_thread_id ? `${m.chat.id}:${m.message_thread_id}` : `${m.chat.id}`;
  return [{ session, text: m.text, chatId: m.chat.id, threadId: m.message_thread_id }];
};

/** fetch calls to a given Bot API method (endsWith disambiguates sendMessage vs sendMessageDraft). */
const callsTo = (m: ReturnType<typeof vi.fn>, method: string) =>
  m.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`)) as [string, RequestInit][];
const bodyOf = (call: [string, RequestInit] | undefined) => {
  if (!call) throw new Error("expected a matching fetch call");
  return JSON.parse(String(call[1].body));
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
    expect(callsTo(fetchMock, "sendMessageDraft").length).toBeGreaterThan(0); // streamed live, not just final
    const sent = callsTo(fetchMock, "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toBe(`${API}/botBOT/sendMessage`);
    expect(bodyOf(sent[0])).toMatchObject({ chat_id: 42, text: "hello back" });
  });

  it("auto-adapts to Threaded Mode: per-thread session + reply sent into the same thread", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("yo");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: threadOn, apiBaseUrl: API });
    const threaded: TelegramUpdate = {
      update_id: 7,
      message: { message_id: 2, text: "hi", message_thread_id: 99, chat: { id: 42, type: "private" } },
    };
    expect((await ch(tgRequest(threaded))).status).toBe(200);
    await flush();
    expect(calls).toEqual([{ session: "42:99", text: "hi" }]);
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0])).toMatchObject({
      chat_id: 42,
      message_thread_id: 99,
      text: "yo",
    });
  });

  it("streams tool activity into the draft (process is visible) and persists only the clean final text", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "tool_started", id: "t1", name: "word-count", args: { text: "the quick brown fox" } };
        yield { type: "tool_ended", id: "t1", isError: false, content: { words: 4 } };
        yield { type: "text", delta: "4 words" };
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: echoOn, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    const draftTexts = callsTo(fetchMock, "sendMessageDraft").map((c) => bodyOf(c).text as string);
    // The tool call shows its name AND a preview of its args, so the process is legible.
    expect(draftTexts.some((t) => /word-count the quick brown fox/.test(t))).toBe(true);
    const sent = callsTo(fetchMock, "sendMessage");
    expect(sent).toHaveLength(1);
    expect(bodyOf(sent[0]).text).toBe("4 words"); // persisted message is the clean answer, no tool noise
  });

  it("does not call sendMessage when the agent reply is empty", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent(""); // completes with no text
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: echoOn, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(callsTo(fetchMock, "sendMessage")).toHaveLength(0); // no final message (a draft may have shown “Thinking…”)
  });

  it("a failing live draft is logged once (not swallowed) and the final reply still sends", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/sendMessageDraft")
        ? new Response("nope", { status: 400 })
        : new Response('{"ok":true}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("final answer");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: echoOn, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(errors.filter((e) => /live draft failed/.test(e))).toHaveLength(1); // surfaced once, not per attempt
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).text).toBe("final answer"); // final still sent
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
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "failed", details: "boom", retryable: false };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: echoOn, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    // dev-facing: the full details reach the operator log.
    expect(errors.some((e) => /turn failed: turn=5#0 session=42/.test(e) && /boom/.test(e))).toBe(true);
    // customer-facing default: the user gets a neutral message, NOT the raw details.
    const userText = bodyOf(callsTo(fetchMock, "sendMessage")[0]).text as string;
    expect(userText).not.toMatch(/boom/);
    expect(userText).toMatch(/something went wrong/i);
    spy.mockRestore();
  });

  it("onError lets a dev bot surface the raw details to the chat (the customer/dev split is configurable)", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "failed", details: "boom", retryable: false };
      },
    };
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      on: echoOn,
      apiBaseUrl: API,
      onError: (f) => `RAW: ${f.details}`,
    });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).text).toBe("RAW: boom");
  });
});
