import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultTelegramRoute, type TelegramUpdate, telegramChannel, telegramEnvelope } from "../src/telegram.ts";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/index.ts";

/** A faux Agent that records each invocation's prompt and replies with `reply`. */
function replyingAgent(reply = "") {
  const calls: Prompt[] = [];
  const agent: Agent = {
    async *invoke(_scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      calls.push(prompt);
      if (reply !== "") yield { type: "text", delta: reply };
      yield { type: "completed" };
    },
  };
  return { agent, calls };
}

/** Let fire-and-forget turns (started after the 200) run before asserting. */
const flush = () => new Promise((r) => setImmediate(r));

const SECRET = "tg-secret";
const API = "http://tg.test";
const act = () => ({}); // route: always answer, all defaults
const ignore = () => null; // route: never answer

function tgRequest(update: unknown, opts: { secret?: string } = {}): Request {
  return new Request("http://app/telegram", {
    method: "POST",
    body: JSON.stringify(update),
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": opts.secret ?? SECRET },
  });
}

const MSG: TelegramUpdate = { update_id: 5, message: { message_id: 1, text: "hi", chat: { id: 42, type: "private" } } };
const callsTo = (m: ReturnType<typeof vi.fn>, method: string) =>
  m.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`)) as [string, RequestInit][];
const bodyOf = (call: [string, RequestInit] | undefined) => {
  if (!call) throw new Error("expected a matching fetch call");
  return JSON.parse(String(call[1].body));
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("defaultTelegramRoute + telegramEnvelope", () => {
  it("answers a private message; stays silent in a group unless summoned", () => {
    expect(defaultTelegramRoute(MSG)).toEqual({}); // private → act
    const group = { id: -100, type: "supergroup" };
    expect(defaultTelegramRoute({ update_id: 1, message: { message_id: 2, text: "chatter", chat: group } })).toBeNull();
    expect(defaultTelegramRoute({ update_id: 1, message: { message_id: 2, text: "/ask", chat: group } })).toEqual({});
    const mention: TelegramUpdate = { update_id: 1, message: { message_id: 2, text: "hey @mybot", chat: group } };
    expect(defaultTelegramRoute(mention)).toBeNull(); // no username → no @mention summon
    expect(defaultTelegramRoute(mention, { botUsername: "mybot" })).toEqual({});
  });

  it("composes a context envelope: chat/thread/sender + reply (with msg id) + the user's text", () => {
    const env = telegramEnvelope({
      message_id: 2,
      text: "what is this",
      message_thread_id: 9,
      chat: { id: 42, type: "private" },
      from: { id: 7, username: "alice" },
      reply_to_message: {
        message_id: 1,
        text: "the log",
        chat: { id: 42, type: "private" },
        from: { id: 8, username: "bob" },
      },
    });
    expect(env).toMatch(/\[telegram: chat 42 \(private\), thread 9, from @alice\]/);
    expect(env).toMatch(/\[in reply to @bob \(msg 1\): the log\]/);
    expect(env).toMatch(/what is this$/);
    expect(env).not.toMatch(/group chat/); // a 1:1 DM gets no group note
  });

  it("attributes a username-less sender by name + id (a shared session must still tell who is who)", () => {
    const env = telegramEnvelope({
      message_id: 3,
      text: "hi",
      chat: { id: -100, type: "supergroup" },
      from: { id: 99, first_name: "Carol" },
    });
    expect(env).toMatch(/from Carol \(id 99\)/);
    expect(env).toMatch(/\[group chat — multiple people; each message is prefixed with its sender\]/);
  });

  it("summarizes a replied-to attachment when it has no text ('summarize this file')", () => {
    const env = telegramEnvelope({
      message_id: 4,
      text: "summarize this",
      chat: { id: 42, type: "private" },
      from: { id: 7, username: "alice" },
      reply_to_message: {
        message_id: 1,
        chat: { id: 42, type: "private" },
        from: { id: 8, username: "bob" },
        document: { file_id: "doc1", file_name: "report.pdf", mime_type: "application/pdf" },
      },
    });
    expect(env).toMatch(/\[in reply to @bob \(msg 1\): \[document: report\.pdf \(application\/pdf\)\]\]/);
  });
});

describe("telegram channel", () => {
  it("rejects non-POST with 405", async () => {
    const { agent } = replyingAgent();
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "B", route: ignore });
    expect((await ch(new Request("http://app/telegram", { method: "GET" }))).status).toBe(405);
  });

  it("refuses an empty secretToken / botToken at construction", () => {
    const { agent } = replyingAgent();
    expect(() => telegramChannel(agent, { secretToken: "", botToken: "B", route: ignore })).toThrow(/secretToken/);
    expect(() => telegramChannel(agent, { secretToken: SECRET, botToken: "", route: ignore })).toThrow(/botToken/);
  });

  it("rejects a missing/wrong secret token with 401 and never routes", async () => {
    const { agent } = replyingAgent();
    let routed = false;
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "B",
      route: () => {
        routed = true;
        return null;
      },
    });
    expect((await ch(tgRequest(MSG, { secret: "wrong" }))).status).toBe(401);
    expect((await ch(new Request("http://app/telegram", { method: "POST", body: "{}" }))).status).toBe(401);
    expect(routed).toBe(false);
  });

  it("rejects an oversized body with 413 before parsing", async () => {
    const { agent } = replyingAgent();
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "B", route: ignore });
    const big = new Request("http://app/telegram", {
      method: "POST",
      body: "x".repeat((1 << 20) + 1),
      headers: { "x-telegram-bot-api-secret-token": SECRET },
    });
    expect((await ch(big)).status).toBe(413);
  });

  it("a verified body that isn't JSON is 400", async () => {
    const { agent } = replyingAgent();
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "B", route: ignore });
    const bad = new Request("http://app/telegram", {
      method: "POST",
      body: "not json{",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
    });
    expect((await ch(bad)).status).toBe(400);
  });

  it("answers a routed update: composes the prompt (envelope) and sends the reply (model A)", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("hello back");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });

    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/\[telegram: chat 42/); // channel composed the envelope
    expect(calls[0]?.text).toMatch(/\bhi\b/); // …around the user's text
    const sent = callsTo(fetchMock, "sendMessage");
    expect(sent).toHaveLength(1);
    expect(bodyOf(sent[0])).toMatchObject({ chat_id: 42, text: "hello back", parse_mode: "HTML" });
    expect(callsTo(fetchMock, "sendMessageDraft").length).toBeGreaterThan(0); // streamed live
  });

  it("uses the default route + getMe when route is omitted (no crash, answers a private chat)", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/getMe")
        ? new Response(JSON.stringify({ ok: true, result: { username: "mybot" } }), { status: 200 })
        : new Response('{"ok":true}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("ok");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", apiBaseUrl: API }); // no route → default
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(callsTo(fetchMock, "sendMessage")).toHaveLength(1);
  });

  it("auto-adapts to Threaded Mode: per-thread session + reply into the same thread", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("yo");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const threaded: TelegramUpdate = {
      update_id: 7,
      message: { message_id: 2, text: "hi", message_thread_id: 99, chat: { id: 42, type: "private" } },
    };
    expect((await ch(tgRequest(threaded))).status).toBe(200);
    await flush();
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0])).toMatchObject({
      chat_id: 42,
      message_thread_id: 99,
      text: "yo",
    });
  });

  it("a custom route can override just the session (reuse the default for the rest)", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      route: (u) => defaultTelegramRoute(u) && { session: `user:${u.message?.from?.id ?? "?"}` },
      apiBaseUrl: API,
    });
    const m: TelegramUpdate = {
      update_id: 8,
      message: { message_id: 1, text: "hi", chat: { id: 42, type: "private" }, from: { id: 7 } },
    };
    await ch(tgRequest(m));
    await flush();
    // (session isn't on the wire, but the turn ran with our key — assert it reached the agent once)
    expect(calls).toHaveLength(1);
  });

  it("streams reasoning (💭) and tool activity into the draft; persists only the clean final text", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "thinking", delta: "weighing options" };
        yield { type: "tool_started", id: "t1", name: "word-count", args: { text: "the quick brown fox" } };
        yield { type: "tool_ended", id: "t1", isError: false, content: { words: 4 } };
        yield { type: "text", delta: "4 words" };
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    const drafts = callsTo(fetchMock, "sendMessageDraft").map((c) => bodyOf(c).text as string);
    expect(drafts[0]).toBe("💭 Thinking…"); // initial draft is an explicit placeholder, never an empty "…"
    expect(drafts.some((t) => /💭/.test(t) && /weighing options/.test(t))).toBe(true);
    expect(drafts.some((t) => /word-count the quick brown fox/.test(t))).toBe(true);
    const sent = callsTo(fetchMock, "sendMessage");
    expect(sent).toHaveLength(1);
    expect(bodyOf(sent[0]).text).toBe("4 words"); // clean final, no thinking/tool noise
  });

  it("replies to the summoning message in a group (threads under the asker), but not in a DM", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("hi");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });

    await ch(
      tgRequest({ update_id: 1, message: { message_id: 77, text: "yo", chat: { id: -100, type: "supergroup" } } }),
    );
    await flush();
    // Full payload: allow_sending_without_reply lets a since-deleted original still deliver.
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).reply_parameters).toMatchObject({
      message_id: 77,
      allow_sending_without_reply: true,
    });

    fetchMock.mockClear();
    await ch(tgRequest(MSG)); // private chat (message_id 1)
    await flush();
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).reply_parameters).toBeUndefined();
  });

  it("still quotes when a custom route returns the same chat explicitly (compares value, not field-presence)", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("hi");
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      apiBaseUrl: API,
      route: (u) => ({ chatId: u.message?.chat.id, session: "custom" }), // same chat, returned explicitly
    });
    await ch(
      tgRequest({ update_id: 1, message: { message_id: 55, text: "yo", chat: { id: -100, type: "supergroup" } } }),
    );
    await flush();
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).reply_parameters).toMatchObject({ message_id: 55 });
  });

  it("on a split group reply, only the first chunk quotes the summoning message", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("x".repeat(9000)); // > 4096 → multiple chunks
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    await ch(
      tgRequest({ update_id: 1, message: { message_id: 88, text: "yo", chat: { id: -100, type: "supergroup" } } }),
    );
    await flush();
    const sends = callsTo(fetchMock, "sendMessage");
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(bodyOf(sends[0]).reply_parameters).toMatchObject({ message_id: 88, allow_sending_without_reply: true }); // first quotes
    for (const s of sends.slice(1)) expect(bodyOf(s).reply_parameters).toBeUndefined(); // rest don't
  });

  it("does not quote when the route redirects the reply to another chat/thread", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("hi");
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      apiBaseUrl: API,
      route: () => ({ chatId: 999 }), // redirect to another chat
    });
    await ch(
      tgRequest({ update_id: 1, message: { message_id: 77, text: "yo", chat: { id: -100, type: "supergroup" } } }),
    );
    await flush();
    const sent = bodyOf(callsTo(fetchMock, "sendMessage")[0]);
    expect(sent.chat_id).toBe(999);
    expect(sent.reply_parameters).toBeUndefined(); // redirected → no quote (avoids a wrong-target reply)
  });

  it("serializes same-session turns (FIFO) instead of dropping the second as 'busy'", async () => {
    let started = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    let release1 = (): void => {};
    const gate1 = new Promise<void>((r) => {
      release1 = r;
    });
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        const id = ++started;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (id === 1) await gate1; // hold the first turn open while the second arrives
        inFlight--;
        order.push(id);
        yield { type: "text", delta: `r${id}` };
        yield { type: "completed" };
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
    );
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const upd = (n: number) => ({
      update_id: n,
      message: { message_id: n, text: "yo", chat: { id: 7, type: "private" } },
    });
    const settle = async (): Promise<void> => {
      for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r));
    };

    await ch(tgRequest(upd(1))); // session "7"
    await ch(tgRequest(upd(2))); // session "7" — queued behind #1, not run concurrently, not dropped
    await settle();
    expect(started).toBe(1); // only turn 1 has invoked; turn 2 waits its turn
    expect(maxInFlight).toBe(1);

    release1();
    await settle();
    expect(order).toEqual([1, 2]); // FIFO
    expect(maxInFlight).toBe(1); // never two at once for the same session
  });

  it("runs different sessions concurrently (no cross-session blocking)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate; // both turns park here at once iff they run concurrently
        inFlight--;
        yield { type: "completed" };
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
    );
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const settle = async (): Promise<void> => {
      for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r));
    };

    await ch(tgRequest({ update_id: 1, message: { message_id: 1, text: "a", chat: { id: 1, type: "private" } } }));
    await ch(tgRequest({ update_id: 2, message: { message_id: 2, text: "b", chat: { id: 2, type: "private" } } }));
    await settle();
    expect(maxInFlight).toBe(2); // different sessions → both in flight at once
    release();
    await settle();
  });

  it("serializes the live preview: never two draft sends in flight (the out-of-order flicker)", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/sendMessageDraft")) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30)); // a real send takes time — events arrive during it
        inFlight--;
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        for (let k = 0; k < 8; k++) yield { type: "thinking", delta: `r${k} ` };
        yield { type: "text", delta: "done" };
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    await ch(tgRequest(MSG));
    await vi.advanceTimersByTimeAsync(5000);
    expect(maxInFlight).toBe(1); // single writer: concurrent draft sends are what reorder frames
    expect(callsTo(fetchMock, "sendMessageDraft").length).toBeLessThan(9); // a burst coalesced, not 1/delta
    expect(callsTo(fetchMock, "sendMessage")).toHaveLength(1); // the authoritative final still sends
  });

  it("keeps the draft alive during a long event-less gap (heartbeat re-pushes it)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "tool_started", id: "t1", name: "write", args: {} };
        await gate;
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    await ch(tgRequest(MSG));
    await vi.advanceTimersByTimeAsync(0);
    const before = callsTo(fetchMock, "sendMessageDraft").length;
    await vi.advanceTimersByTimeAsync(21_000);
    expect(callsTo(fetchMock, "sendMessageDraft").length).toBeGreaterThan(before);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("sends HTML, falling back to plain text when Telegram rejects the markup", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/sendMessage")) {
        return JSON.parse(String(init.body)).parse_mode === "HTML"
          ? new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities: bad" }), {
              status: 400,
            })
          : new Response('{"ok":true}', { status: 200 });
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("<b>oops");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    const sends = callsTo(fetchMock, "sendMessage");
    expect(sends).toHaveLength(2); // HTML rejected → plain retry
    expect(bodyOf(sends[0]).parse_mode).toBe("HTML");
    expect(bodyOf(sends[1]).parse_mode).toBeUndefined();
  });

  it("splits a reply longer than 4096 chars into multiple messages", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("x".repeat(9000));
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    const sends = callsTo(fetchMock, "sendMessage");
    expect(sends.length).toBeGreaterThanOrEqual(3);
    for (const s of sends) expect((bodyOf(s).text as string).length).toBeLessThanOrEqual(4096);
  });

  it("auto-extracts a photo from the message and passes it to the agent as a (vision) image", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/getFile"))
        return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/x.jpg", file_size: 3 } }), {
          status: 200,
        });
      if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const photo: TelegramUpdate = {
      update_id: 9,
      message: {
        message_id: 3,
        caption: "what is this",
        photo: [{ file_id: "f1", file_unique_id: "u", width: 9, height: 9 }],
        chat: { id: 42, type: "private" },
      },
    };
    expect((await ch(tgRequest(photo))).status).toBe(200);
    await flush();
    await flush();
    await flush();
    expect(calls[0]?.images).toHaveLength(1);
    expect(calls[0]?.images?.[0]).toMatchObject({
      mimeType: "image/jpeg",
      data: Buffer.from([1, 2, 3]).toString("base64"),
    });
  });

  it("downloads an inbound document to disk and appends its path to the prompt", async () => {
    const cwd0 = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "fa-tg-"));
    process.chdir(tmp);
    try {
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).endsWith("/getFile"))
          return new Response(
            JSON.stringify({ ok: true, result: { file_path: "documents/report.pdf", file_size: 5 } }),
            { status: 200 },
          );
        if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 });
        return new Response('{"ok":true}', { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { agent, calls } = replyingAgent("ok");
      const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
      const doc: TelegramUpdate = {
        update_id: 11,
        message: {
          message_id: 4,
          caption: "summarize",
          document: { file_id: "d1", file_name: "report.pdf" },
          chat: { id: 77, type: "private" },
        },
      };
      expect((await ch(tgRequest(doc))).status).toBe(200);
      for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      const dest = join(tmp, ".fastagent/telegram-files/77/report.pdf");
      expect(existsSync(dest)).toBe(true);
      expect(calls[0]?.text).toMatch(/attached files/);
      expect(calls[0]?.text).toContain(dest);
    } finally {
      process.chdir(cwd0);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces an attachment fetch failure to the user (not a silent skip) and does not run the agent", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/getFile")
        ? new Response(JSON.stringify({ ok: false }), { status: 200 })
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
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      route: act,
      apiBaseUrl: API,
      onError: (f) => `ERR: ${f.details}`,
    });
    const photo: TelegramUpdate = {
      update_id: 9,
      message: {
        message_id: 3,
        photo: [{ file_id: "f1", file_unique_id: "u", width: 1, height: 1 }],
        chat: { id: 42, type: "private" },
      },
    };
    expect((await ch(tgRequest(photo))).status).toBe(200);
    await flush();
    await flush();
    await flush();
    expect(invoked).toBe(false);
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).text).toMatch(/could not load attachment/);
    expect(errors.some((e) => /turn failed/.test(e))).toBe(true);
  });

  it("a failing live draft is logged once (not swallowed) and the final reply still sends", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/sendMessageDraft")
        ? new Response(JSON.stringify({ ok: false, description: "nope" }), { status: 400 })
        : new Response('{"ok":true}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("final answer");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    const draftErrs = errors.filter((e) => /live draft failed/.test(e));
    expect(draftErrs).toHaveLength(1);
    expect(draftErrs[0]).toMatch(/nope/);
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).text).toBe("final answer");
  });

  it("a failed event tells the user (neutral by default) and logs the turn as failed", async () => {
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
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(errors.some((e) => /turn failed/.test(e) && /boom/.test(e))).toBe(true); // dev log
    const userText = bodyOf(callsTo(fetchMock, "sendMessage")[0]).text as string;
    expect(userText).not.toMatch(/boom/); // customer-facing: neutral, no leaked details
    expect(userText).toMatch(/something went wrong/i);
    spy.mockRestore();
  });
});
