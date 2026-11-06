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

type Answer = { status?: number; body: unknown } | (() => { status?: number; body: unknown });
type Script = Record<string, Answer[]>;

/**
 * A Bot API that answers each method from its script, in order, and remembers what it was asked. A script's last
 * answer repeats, except for `getUpdates`: once its answers are spent a poll is held open as Telegram holds one, until
 * it is aborted, so a quiet bot is not a hot loop.
 */
function botApi(script: Script) {
  const asked: { method: string; params: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() as string;
    const params = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    asked.push({ method, params });
    const answers = script[method];
    if (method === "getUpdates" && (answers === undefined || answers.length === 0)) {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    }
    const next =
      method === "getUpdates" ? answers?.shift() : answers && answers.length > 1 ? answers.shift() : answers?.[0];
    const answer = typeof next === "function" ? next() : next;
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
const fail = (status: number, description: string): Answer => ({ status, body: { ok: false, description } });
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

  it("leaves a bot with no webhook alone", async () => {
    const api = botApi({ getWebhookInfo: [ok({ url: "" })], getUpdates: [ok([])] });
    const { connection } = poll(() => {});
    await connection.ready;
    expect(api.calls("deleteWebhook")).toEqual([]);
  });

  it("hands each update over in order and confirms them by asking past the last id", async () => {
    const taken: number[] = [];
    const api = botApi({
      getWebhookInfo: [ok({})],
      getUpdates: [ok([update(10), update(11)]), ok([update(12)]), ok([])],
    });
    poll((u) => taken.push(u.update_id));
    await vi.waitFor(() => expect(taken).toEqual([10, 11, 12]));
    await vi.waitFor(() => expect(api.calls("getUpdates").length).toBeGreaterThanOrEqual(4));
    expect(api.calls("getUpdates").map((c) => c.params.offset)).toEqual(
      [undefined, 12, 13, 13].slice(0, api.calls("getUpdates").length),
    );
  });

  it("skips an update that was not taken, says so, and goes on past it", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const taken: number[] = [];
    const api = botApi({
      getWebhookInfo: [ok({})],
      getUpdates: [ok([update(1), update(2)]), ok([])],
    });
    poll((u) => {
      if (u.update_id === 1) throw new Error("route threw");
      taken.push(u.update_id);
    });
    await vi.waitFor(() => expect(taken).toEqual([2]));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("update 1 was not taken, and is skipped: Error: route threw"),
    );
    await vi.waitFor(() => expect(api.calls("getUpdates")[1]?.params.offset).toBe(3));
  });

  it("ends with the reason when Telegram refuses the token", async () => {
    botApi({ getWebhookInfo: [fail(401, "Unauthorized")] });
    const { connection } = poll(() => {});
    await expect(connection.ready).rejects.toThrow("401 Unauthorized");
    await expect(connection.closed).rejects.toThrow("401 Unauthorized");
  });

  it("does not retry a start it could not make: that is the operator's to see", async () => {
    const api = botApi({ getWebhookInfo: [ok({})], getUpdates: [fail(502, "Bad Gateway")] });
    const { connection } = poll(() => {});
    await expect(connection.ready).rejects.toThrow("502");
    expect(api.calls("getUpdates")).toHaveLength(1);
  });

  it("retries a failure that can pass once it is running, with a growing wait", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const taken: number[] = [];
    const api = botApi({
      getWebhookInfo: [ok({})],
      getUpdates: [ok([]), fail(502, "Bad Gateway"), fail(502, "Bad Gateway"), ok([update(7)]), ok([])],
    });
    poll((u) => taken.push(u.update_id));
    await vi.waitFor(() => expect(taken).toEqual([7]));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("getUpdates failed, retrying in 0.001s"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retrying in 0.002s"));
    expect(api.calls("getUpdates").length).toBeGreaterThanOrEqual(4);
  });

  it("a second process polling the same bot is asked again three times, then ends the connection", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const api = botApi({
      getWebhookInfo: [ok({})],
      getUpdates: [
        ok([]),
        ...Array.from({ length: 4 }, () =>
          fail(
            409,
            "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
          ),
        ),
      ],
    });
    const { connection } = poll(() => {});
    await expect(connection.closed).rejects.toThrow("another process polls this bot");
    expect(api.calls("getUpdates")).toHaveLength(1 + 4); // the answer that proved the start, then 1 + 3 conflicts
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("(3/3)"));
  });

  it("a conflict that passes does not count against the next one", async () => {
    const taken: number[] = [];
    botApi({
      getWebhookInfo: [ok({})],
      getUpdates: [
        ok([]),
        fail(409, "Conflict: terminated by other getUpdates request"),
        fail(409, "Conflict: terminated by other getUpdates request"),
        ok([update(1)]),
        fail(409, "Conflict: terminated by other getUpdates request"),
        fail(409, "Conflict: terminated by other getUpdates request"),
        ok([update(2)]),
        ok([]),
      ],
    });
    poll((u) => taken.push(u.update_id));
    await vi.waitFor(() => expect(taken).toEqual([1, 2]));
  });

  it("a webhook set under the poll ends the connection at once: another instance receives by it", async () => {
    const api = botApi({
      getWebhookInfo: [ok({})],
      getUpdates: [
        ok([]),
        fail(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook"),
      ],
    });
    const { connection } = poll(() => {});
    await expect(connection.closed).rejects.toThrow("a webhook was set for this bot while it polls");
    expect(api.calls("getUpdates")).toHaveLength(2);
  });

  it("an abort ends it cleanly, and one before the first answer is a cancellation, not a failure", async () => {
    botApi({ getWebhookInfo: [ok({})], getUpdates: [ok([])] });
    const running = poll(() => {});
    await running.connection.ready;
    running.abort.abort();
    await expect(running.connection.closed).resolves.toBeUndefined();

    botApi({ getWebhookInfo: [ok({})], getUpdates: [ok([])] });
    const early = pollTelegramUpdates(
      { apiBaseUrl: API, botToken: TOKEN, accept: () => {}, timing: FAST },
      AbortSignal.abort(),
    );
    await expect(early.ready).resolves.toBeUndefined();
    await expect(early.closed).resolves.toBeUndefined();
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

  it("needs a bot token to be mounted, with no webhook secret asked for", () => {
    const channel = telegramPollingChannel({ botToken: "", apiBaseUrl: API });
    const root = mkdtempSync(join(tmpdir(), "tg-poll-"));
    roots.push(root);
    const agent = scriptedAgent(async function* () {});
    expect(() => channel.connect(channelContext(agent, root, "telegram"), new AbortController().signal)).toThrow(
      "telegramChannel requires a non-empty botToken",
    );
  });
});
