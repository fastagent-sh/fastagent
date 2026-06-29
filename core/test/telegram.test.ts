import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("streams model reasoning into the draft (💭) but keeps it out of the persisted final message", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "thinking", delta: "weighing options" };
        // a tool event force-flushes a draft, capturing the accumulated reasoning (text deltas throttle)
        yield { type: "tool_started", id: "t1", name: "read", args: {} };
        yield { type: "tool_ended", id: "t1", isError: false, content: {} };
        yield { type: "text", delta: "the answer" };
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: echoOn, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    const draftTexts = callsTo(fetchMock, "sendMessageDraft").map((c) => bodyOf(c).text as string);
    expect(draftTexts.some((t) => /💭/.test(t) && /weighing options/.test(t))).toBe(true); // reasoning shown live
    const sent = callsTo(fetchMock, "sendMessage");
    expect(sent).toHaveLength(1);
    expect(bodyOf(sent[0]).text).toBe("the answer"); // final excludes the reasoning
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

  it("keeps the draft alive during a long event-less gap (heartbeat re-pushes it)", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      let release = (): void => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const agent: Agent = {
        async *invoke(): AsyncIterable<AgentEvent> {
          yield { type: "tool_started", id: "t1", name: "write", args: {} };
          await gate; // a long step that emits no events
          yield { type: "completed" };
        },
      };
      const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: echoOn, apiBaseUrl: API });
      await ch(tgRequest(MSG));
      await vi.advanceTimersByTimeAsync(0); // let the turn park at `await gate`
      const before = callsTo(fetchMock, "sendMessageDraft").length;
      await vi.advanceTimersByTimeAsync(21_000); // past the 20s keepalive
      expect(callsTo(fetchMock, "sendMessageDraft").length).toBeGreaterThan(before); // heartbeat fired
      release();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes parseMode to the final message but keeps the streamed draft plain", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("**bold**");
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      on: echoOn,
      apiBaseUrl: API,
      parseMode: "Markdown",
    });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0])).toMatchObject({ text: "**bold**", parse_mode: "Markdown" });
    expect(bodyOf(callsTo(fetchMock, "sendMessageDraft")[0]).parse_mode).toBeUndefined(); // drafts stay plain
  });

  it("fetches Telegram photos (getFile → download) and passes them to the agent as images", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/getFile"))
        return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/x.jpg", file_size: 3 } }), {
          status: 200,
        });
      if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response('{"ok":true}', { status: 200 }); // sendMessage / sendMessageDraft
    });
    vi.stubGlobal("fetch", fetchMock);
    let received: Prompt | undefined;
    const agent: Agent = {
      async *invoke(_scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
        received = prompt;
        yield { type: "completed" };
      },
    };
    const photoOn = (u: TelegramUpdate) => {
      const m = u.message;
      return m
        ? [
            {
              session: `${m.chat.id}`,
              text: m.caption ?? "",
              chatId: m.chat.id,
              imageFileIds: m.photo?.map((p) => p.file_id),
            },
          ]
        : [];
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: photoOn, apiBaseUrl: API });
    const photoMsg: TelegramUpdate = {
      update_id: 9,
      message: {
        message_id: 3,
        caption: "what is this",
        photo: [{ file_id: "f1", file_unique_id: "u", width: 90, height: 90 }],
        chat: { id: 42, type: "private" },
      },
    };
    expect((await ch(tgRequest(photoMsg))).status).toBe(200);
    await flush();
    await flush();
    await flush();
    expect(received?.text).toBe("what is this");
    expect(received?.images).toHaveLength(1);
    expect(received?.images?.[0]).toMatchObject({
      mimeType: "image/jpeg",
      data: Buffer.from([1, 2, 3]).toString("base64"),
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/file/botBOT/photos/x.jpg"))).toBe(true);
  });

  it("surfaces an image fetch failure to the user (not a silent skip) and does not run the agent", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/getFile")
        ? new Response(JSON.stringify({ ok: false }), { status: 200 }) // getFile fails
        : new Response('{"ok":true}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let invoked = false;
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        invoked = true;
        yield { type: "completed" };
      },
    };
    const photoOn = (u: TelegramUpdate) => {
      const m = u.message;
      return m ? [{ session: `${m.chat.id}`, text: "", chatId: m.chat.id, imageFileIds: ["f1"] }] : [];
    };
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      on: photoOn,
      apiBaseUrl: API,
      onError: (f) => `ERR: ${f.details}`,
    });
    const photoMsg: TelegramUpdate = {
      update_id: 9,
      message: {
        message_id: 3,
        photo: [{ file_id: "f1", file_unique_id: "u", width: 1, height: 1 }],
        chat: { id: 42, type: "private" },
      },
    };
    expect((await ch(tgRequest(photoMsg))).status).toBe(200);
    await flush();
    await flush();
    await flush();
    expect(invoked).toBe(false); // did not run the agent on input we failed to load
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).text).toMatch(/could not load attachment/); // user told
    expect(errors.some((e) => /turn failed/.test(e))).toBe(true); // operator log
  });

  it("downloads an inbound file to disk and appends its path to the prompt for the agent's tools", async () => {
    const cwd0 = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "fa-tg-"));
    process.chdir(tmp);
    try {
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).endsWith("/getFile"))
          return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/report.pdf", file_size: 5 } }), {
            status: 200,
          });
        if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 });
        return new Response('{"ok":true}', { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      let received: Prompt | undefined;
      const agent: Agent = {
        async *invoke(_scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
          received = prompt;
          yield { type: "completed" };
        },
      };
      const fileOn = (u: TelegramUpdate) => {
        const m = u.message;
        return m ? [{ session: `${m.chat.id}`, text: "summarize this", chatId: m.chat.id, fileIds: ["d1"] }] : [];
      };
      const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", on: fileOn, apiBaseUrl: API });
      const docMsg: TelegramUpdate = {
        update_id: 11,
        message: { message_id: 4, document: { file_id: "d1", file_name: "report.pdf" }, chat: { id: 77, type: "private" } },
      };
      expect((await ch(tgRequest(docMsg))).status).toBe(200);
      for (let i = 0; i < 100 && !received; i++) await new Promise((r) => setTimeout(r, 5)); // await the fs write
      const dest = join(tmp, ".fastagent/telegram-files/77/report.pdf");
      expect(existsSync(dest)).toBe(true); // downloaded to a local path
      expect(received?.text).toContain("summarize this");
      expect(received?.text).toMatch(/attached files/);
      expect(received?.text).toContain(dest); // path handed to the agent for its tools
    } finally {
      process.chdir(cwd0);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retries a parse_mode reply as plain text when Telegram rejects the markup", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/sendMessage")) {
        const hasParse = JSON.parse(String(init.body)).parse_mode !== undefined;
        return hasParse
          ? new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities: bad" }), {
              status: 400,
            })
          : new Response('{"ok":true}', { status: 200 });
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("<b>oops");
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      on: echoOn,
      apiBaseUrl: API,
      parseMode: "HTML",
    });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    const sends = callsTo(fetchMock, "sendMessage");
    expect(sends).toHaveLength(2); // first with parse_mode (rejected), then a plain-text retry
    expect(bodyOf(sends[0]).parse_mode).toBe("HTML");
    expect(bodyOf(sends[1]).parse_mode).toBeUndefined();
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
    const draftErrs = errors.filter((e) => /live draft failed/.test(e));
    expect(draftErrs).toHaveLength(1); // surfaced once, not per attempt
    expect(draftErrs[0]).toMatch(/nope/); // includes the Telegram response body, not just the status
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
