import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelContext } from "../src/channels/context.ts";
import { pollTelegramUpdates } from "../src/channels/telegram/polling.ts";
import { log } from "../src/log.ts";
import { type TelegramUpdate, telegramPollingChannel } from "../src/telegram.ts";
import { ev } from "./scripted-run.ts";
import { type Prompt, promptOf, scriptedAgent } from "./scripted-agent.ts";

const API = "http://tg.test";
const TOKEN = "1:A";

type Answer = { status?: number; body: unknown } | (() => { status?: number; body: unknown }) | "hang";
type Script = Record<string, Answer[]>;

/**
 * A Bot API that answers each method from its script, in order, and remembers what it was asked. A script's last
 * answer repeats, except for `getUpdates`: once its answers are spent a poll is held open as Telegram holds one, until
 * it is aborted, so a quiet bot is not a hot loop. Like a real fetch, a call honours its signal: one already aborted
 * fails at once, and an answer of "hang" holds the call until the abort.
 */
function botApi(script: Script) {
  const asked: { method: string; params: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() as string;
    const params = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    asked.push({ method, params });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const held = () =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    const answers = script[method];
    if (method === "getUpdates" && (answers === undefined || answers.length === 0)) return held();
    if (answers?.[0] === "hang") return held();
    const next =
      method === "getUpdates" ? answers?.shift() : answers && answers.length > 1 ? answers.shift() : answers?.[0];
    const answer = typeof next === "function" ? next() : next === "hang" ? undefined : next;
    // A method nobody scripted is fine for the channel's own calls (getMe, sendMessage…): ok, with an empty result.
    const { status = 200, body } = answer ?? {
      body: { ok: true, result: method === "sendMessage" ? { message_id: 1 } : {} },
    };
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetch);
  return { asked, calls: (method: string) => asked.filter((entry) => entry.method === method) };
}

const ok = (result: unknown): Answer => ({ body: { ok: true, result } });
const update = (id: number, text = "hi"): TelegramUpdate => ({
  update_id: id,
  message: { message_id: id, text, chat: { id: 42, type: "private" } },
});

const FAST = { retryFirstMs: 1, retryCapMs: 2, conflictWaitMs: 1, longPollS: 30 };
const connections: AbortController[] = [];
const poll = (accept: (u: TelegramUpdate) => void, timing = FAST) => {
  const abort = new AbortController();
  connections.push(abort);
  const connection = pollTelegramUpdates({ apiBaseUrl: API, botToken: TOKEN, accept, timing }, abort.signal);
  // A failure is read through `closed` in these tests; `ready` is read where one asks for it.
  connection.closed.catch(() => {});
  connection.ready.catch(() => {});
  return { connection, abort };
};

afterEach(() => {
  for (const abort of connections.splice(0)) abort.abort();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("telegram long polling", () => {
  it("takes the webhook away first, says so, and is ready after an answer that did not wait", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const api = botApi({
      getWebhookInfo: [ok({ url: "https://old.example.com/telegram" })],
      getUpdates: [ok([])],
    });
    const { connection } = poll(() => {});
    await connection.ready;
    expect(api.calls("deleteWebhook")).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("deleted the bot's webhook (https://old.example.com/telegram)"),
    );
    // The call that proved the token is a short one: a quiet bot must not hold readiness for a whole long poll.
    expect(api.calls("getUpdates")[0]?.params).toEqual({ timeout: 0 });
    // Afterwards it waits on Telegram.
    await vi.waitFor(() => expect(api.calls("getUpdates").length).toBeGreaterThan(1));
    expect(api.calls("getUpdates")[1]?.params).toEqual({ timeout: 30 });
  });
});

describe("telegramPollingChannel", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("answers an update it polled the way the webhook channel answers one it was sent", async () => {
    const prompts: Prompt[] = [];
    const agent = scriptedAgent(async function* (request) {
      yield ev.message();
      prompts.push(promptOf(request));
      yield ev.text("hello back");
      yield ev.ended();
    });
    const api = botApi({
      getMe: [ok({ username: "mybot" })],
      getWebhookInfo: [ok({})],
      getUpdates: [ok([update(5, "hello there")]), ok([])],
      sendMessage: [ok({ message_id: 100 })],
    });
    const root = mkdtempSync(join(tmpdir(), "tg-poll-"));
    roots.push(root);
    const abort = new AbortController();
    connections.push(abort);
    const channel = telegramPollingChannel({ botToken: TOKEN, apiBaseUrl: API });
    expect(channel.name).toBe("telegram long polling");
    const connection = channel.connect(channelContext(agent, root, "telegram"), abort.signal);
    await connection.ready;
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]?.text).toContain("hello there");
    await vi.waitFor(() =>
      expect(api.calls("sendMessage").length + api.calls("editMessageText").length).toBeGreaterThan(0),
    );
    expect(JSON.stringify(api.calls("sendMessage")[0]?.params)).toContain('"chat_id":42');
  });
});
