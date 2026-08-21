import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/index.ts";
import type { SessionCommand, SessionControl } from "../src/session.ts";
import { type FeishuChannelOptions, feishuChannel as buildFeishuChannel } from "../src/feishu.ts";
import { larkChannel } from "../src/lark.ts";
import { eventSignature } from "../src/channels/feishu/crypto.ts";
import { cardSummary } from "../src/channels/feishu/card.ts";
import { log } from "../src/log.ts";

const TOKEN = "verif-token";
const BASE = "http://feishu.test";

/** A faux Agent that records each invocation's scope+prompt and replies with `reply`. */
function replyingAgent(reply = "") {
  const calls: { scope: Scope; prompt: Prompt }[] = [];
  const agent: Agent = {
    async *invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      calls.push({ scope, prompt });
      if (reply !== "") yield { type: "text", delta: reply };
      yield { type: "completed" };
    },
  };
  return { agent, calls };
}

// Channels built via the test helper register their turn-queue `idle()` here so afterEach can drain a
// test's fire-and-forget turns BEFORE unstubbing fetch (mirrors telegram.test.ts).
const channelIdles = new Set<() => Promise<void>>();
const tempRoots: string[] = [];

/** Settle async until the fetch mock goes quiet (mid-flight observations only; the drain is afterEach). */
const flush = async () => {
  const f = globalThis.fetch as unknown as { mock?: { calls: unknown[] } };
  let prev = -1;
  for (let i = 0; i < 100 && (f.mock?.calls.length ?? 0) !== prev; i++) {
    prev = f.mock?.calls.length ?? 0;
    await new Promise((r) => setImmediate(r));
  }
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.race([Promise.all([...channelIdles].map((idle) => idle())), new Promise((r) => setTimeout(r, 2000))]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  channelIdles.clear();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Open-platform fetch mock: token/botInfo/cards/messages/resources all answer; every request is
 * recorded as { url, method, body } for assertions.
 */
function feishuFetch(
  overrides: Partial<Record<string, (url: string, init: RequestInit) => Response | Promise<Response>>> = {},
) {
  const seen: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let msgId = 0;
  let cardId = 0;
  const fetchMock = vi.fn(async (rawUrl: string, init: RequestInit = {}) => {
    const url = String(rawUrl);
    const method = init.method ?? "GET";
    let body: Record<string, unknown> | undefined;
    try {
      body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
    } catch {
      body = undefined;
    }
    seen.push({ url, method, body });
    for (const [needle, fn] of Object.entries(overrides)) {
      if (url.includes(needle) && fn) return fn(url, init);
    }
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
    }
    if (url.includes("/bot/v3/info")) {
      return Response.json({ code: 0, msg: "ok", bot: { open_id: "ou_bot", app_name: "Bot" } });
    }
    if (url.includes("/resources/")) {
      return new Response(Buffer.from("img-bytes"), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (/\/cardkit\/v1\/cards$/.test(url))
      return Response.json({ code: 0, msg: "ok", data: { card_id: `c${++cardId}` } });
    if (url.includes("/cardkit/v1/cards/")) return Response.json({ code: 0, msg: "ok", data: {} });
    if (url.includes("/im/v1/messages") && (method === "POST" || method === "PUT" || method === "DELETE")) {
      return Response.json({ code: 0, msg: "ok", data: { message_id: `om_bot_${++msgId}` } });
    }
    if (url.includes("/im/v1/messages/") && method === "GET") {
      return Response.json({ code: 0, msg: "ok", data: { items: [] } });
    }
    return Response.json({ code: 0, msg: "ok", data: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  const calls = (needle: string, method?: string) =>
    seen.filter((c) => c.url.includes(needle) && (method === undefined || c.method === method));
  return { fetchMock, seen, calls };
}

/** Build a channel on a temp state root; returns the handler + the recorded agent + the state home. */
function buildChannel(
  opts: Partial<FeishuChannelOptions> & { control?: SessionControl; canReadLocalFiles?: boolean } = {},
  agentReply = "the answer",
) {
  const { control, canReadLocalFiles, ...channelOpts } = opts;
  const root = mkdtempSync(join(tmpdir(), "feishu-state-"));
  tempRoots.push(root);
  const { agent, calls } = replyingAgent(agentReply);
  const routes = buildFeishuChannel({
    appId: "app",
    appSecret: "secret",
    verificationToken: TOKEN,
    apiBaseUrl: BASE,
    ...channelOpts,
  })({ agent: opts2Agent(opts) ?? agent, stateRoot: root, control, canReadLocalFiles });
  const handler = routes["POST /feishu"];
  if (!handler) throw new Error("expected POST /feishu");
  const maybeIdle = (handler as { turnsIdle?: () => Promise<void> }).turnsIdle;
  if (maybeIdle) channelIdles.add(maybeIdle);
  const idle = maybeIdle ?? (async () => {});
  return { handler, agent, calls, root, home: join(root, "channels", "feishu"), idle };
}
// buildChannel accepts a custom agent through opts via this side-channel to keep the signature small.
let injectedAgent: Agent | undefined;
function opts2Agent(_opts: unknown): Agent | undefined {
  const a = injectedAgent;
  injectedAgent = undefined;
  return a;
}

function feishuRequest(payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://app/feishu", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A v2.0 im.message.receive_v1 envelope (plaintext mode). */
function messageEvent(over: {
  id?: string;
  chatType?: string;
  chatId?: string;
  text?: string;
  msgType?: string;
  content?: string;
  mentions?: unknown[];
  senderType?: string;
  senderId?: string | null;
  parentId?: string;
  rootId?: string;
  threadId?: string;
}) {
  return {
    schema: "2.0",
    header: { event_id: `ev_${over.id ?? "1"}`, event_type: "im.message.receive_v1", token: TOKEN },
    event: {
      sender: {
        sender_type: over.senderType ?? "user",
        // `senderId: null` models a tenant whose events carry no id flavour at all.
        sender_id: over.senderId === null ? {} : { open_id: over.senderId ?? "ou_alice" },
      },
      message: {
        message_id: over.id ?? "om_1",
        chat_id: over.chatId ?? "oc_1",
        chat_type: over.chatType ?? "p2p",
        message_type: over.msgType ?? "text",
        content: over.content ?? JSON.stringify({ text: over.text ?? "hi" }),
        ...(over.mentions ? { mentions: over.mentions } : {}),
        ...(over.parentId ? { parent_id: over.parentId } : {}),
        ...(over.rootId ? { root_id: over.rootId } : {}),
        ...(over.threadId ? { thread_id: over.threadId } : {}),
      },
    },
  };
}

describe("bot identity cache (the lazy-construction mention race)", () => {
  const MENTION = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];
  const build = (root: string) => {
    const { agent, calls } = replyingAgent("the answer");
    const routes = buildFeishuChannel({
      appId: "app",
      appSecret: "secret",
      verificationToken: TOKEN,
      apiBaseUrl: BASE,
    })({
      agent,
      stateRoot: root,
    });
    const handler = routes["POST /feishu"];
    if (!handler) throw new Error("expected POST /feishu");
    const idle = (handler as { turnsIdle?: () => Promise<void> }).turnsIdle ?? (async () => {});
    channelIdles.add(idle as () => Promise<void>);
    return { handler, calls, idle };
  };

  it("persists the resolved identity, and the NEXT mount answers a mention BEFORE bot/v3/info returns", async () => {
    const root = mkdtempSync(join(tmpdir(), "feishu-bot-cache-"));
    tempRoots.push(root);
    // Mount 1: bot/v3/info resolves normally → the identity lands in bot.json.
    feishuFetch();
    build(root);
    await flush();
    expect(JSON.parse(readFileSync(join(root, "channels", "feishu", "bot.json"), "utf8"))).toEqual({
      appId: "app", // bound to the app: kept state must not hand this identity to a different appId
      openId: "ou_bot",
    });

    // Mount 2 (a cold start): bot/v3/info HANGS — under AgentCore's lazy construction the first
    // envelope dispatches in the same tick as construction, so a network answer can never arrive in
    // time. The cached identity must carry the summon: without it this explicit @ is buffered as
    // bystander context (the field-observed regression).
    feishuFetch({ "/bot/v3/info": () => new Promise<Response>(() => {}) });
    const second = build(root);
    await second.handler(
      feishuRequest(
        messageEvent({
          id: "om_first_after_cold_start",
          chatType: "group",
          content: JSON.stringify({ text: "@_user_1 出来" }),
          mentions: MENTION,
        }),
      ),
    );
    await second.idle();
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.prompt.text).toContain("出来");
  });

  it("with no cache and an unresolved bot/v3/info, a mention is BUFFERED — folded into the next turn, never lost", async () => {
    const root = mkdtempSync(join(tmpdir(), "feishu-bot-nocache-"));
    tempRoots.push(root);
    // A controllable identity: mention #1 arrives while bot/v3/info is still pending.
    let releaseBotInfo!: (r: Response) => void;
    const gate = new Promise<Response>((r) => {
      releaseBotInfo = r;
    });
    feishuFetch({ "/bot/v3/info": () => gate });
    const { handler, calls, idle } = build(root);
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_prelaunch",
          chatType: "group",
          content: JSON.stringify({ text: "@_user_1 早于身份的提问" }),
          mentions: MENTION,
        }),
      ),
    );
    await idle();
    expect(calls).toHaveLength(0); // fail-closed: not answered while the identity is unknown…

    releaseBotInfo(Response.json({ code: 0, msg: "ok", bot: { open_id: "ou_bot", app_name: "Bot" } }));
    await flush();
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_after_identity",
          chatType: "group",
          content: JSON.stringify({ text: "@_user_1 现在呢" }),
          mentions: MENTION,
        }),
      ),
    );
    await idle();
    expect(calls).toHaveLength(1);
    // …and "delayed, never lost" is a claim about the BUFFER, so prove it: the eaten mention rides
    // the next answered turn as context. Asserting only "not answered" would also pass for a drop.
    expect(calls[0]?.prompt.text).toContain("recent group discussion");
    expect(calls[0]?.prompt.text).toContain("早于身份的提问");
  });

  it("a cache written by a DIFFERENT app is ignored — kept state must not let a new app impersonate the old bot", async () => {
    const root = mkdtempSync(join(tmpdir(), "feishu-bot-otherapp-"));
    tempRoots.push(root);
    mkdirSync(join(root, "channels", "feishu"), { recursive: true });
    // The operator swapped FEISHU_APP_ID but kept the state dir: the file names the OLD app.
    writeFileSync(
      join(root, "channels", "feishu", "bot.json"),
      JSON.stringify({ appId: "some_previous_app", openId: "ou_bot" }),
    );
    feishuFetch({ "/bot/v3/info": () => new Promise<Response>(() => {}) });
    const { handler, calls, idle } = build(root);
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_old_bot_mention",
          chatType: "group",
          content: JSON.stringify({ text: "@_user_1 老bot在吗" }),
          mentions: MENTION, // mentions ou_bot — the OLD app's identity
        }),
      ),
    );
    await idle();
    expect(calls).toHaveLength(0); // fail-closed, not an answer under a borrowed identity
  });

  it("a successful bot/v3/info WITHOUT an open_id invalidates the cache — fail-closed is restored, not papered over", async () => {
    const root = mkdtempSync(join(tmpdir(), "feishu-bot-invalidate-"));
    tempRoots.push(root);
    // Mount 1: identity resolves and lands on disk.
    feishuFetch();
    build(root);
    await flush();
    expect(JSON.parse(readFileSync(join(root, "channels", "feishu", "bot.json"), "utf8")).openId).toBe("ou_bot");

    // Mount 2: the platform AFFIRMATIVELY reports no identity (bot capability off) — unlike a failed
    // call, this must clear the cache, or a summon identity the platform declined to confirm keeps
    // routing (fail-open).
    feishuFetch({ "/bot/v3/info": () => Response.json({ code: 0, msg: "ok", bot: {} }) });
    const second = build(root);
    await flush();
    await second.handler(
      feishuRequest(
        messageEvent({
          id: "om_after_invalidate",
          chatType: "group",
          content: JSON.stringify({ text: "@_user_1 还在吗" }),
          mentions: MENTION,
        }),
      ),
    );
    await second.idle();
    expect(second.calls).toHaveLength(0); // no borrowed identity
    expect(JSON.parse(readFileSync(join(root, "channels", "feishu", "bot.json"), "utf8")).openId).toBeUndefined(); // disk cleared too
  });
});

describe("construction fails closed", () => {
  it("requires appId/appSecret/verificationToken at mount (metadata remains inspectable before secrets exist)", () => {
    const ctx = { agent: {} as Agent, stateRoot: "/tmp/unused-feishu-construction" };
    expect(() => buildFeishuChannel({ appId: "", appSecret: "s", verificationToken: "t" })(ctx)).toThrow(/appId/);
    expect(() => buildFeishuChannel({ appId: "a", appSecret: "s", verificationToken: "" })(ctx)).toThrow(
      /verificationToken/,
    );
  });

  it("rejects a relative ctx.stateRoot (fail visibly, never a silent cwd re-anchor)", () => {
    feishuFetch();
    const { agent } = replyingAgent();
    expect(() =>
      buildFeishuChannel({ appId: "a", appSecret: "s", verificationToken: "t" })({ agent, stateRoot: "rel" }),
    ).toThrow(/stateRoot/);
  });
});

describe("ingress verification", () => {
  it("405s non-POST, 400s invalid json, 413s an oversized body", async () => {
    feishuFetch();
    const { handler } = buildChannel();
    expect((await handler(new Request("http://app/feishu", { method: "GET" }))).status).toBe(405);
    expect((await handler(new Request("http://app/feishu", { method: "POST", body: "not json" }))).status).toBe(400);
    const big = new Request("http://app/feishu", { method: "POST", body: `"${"a".repeat((1 << 20) + 10)}"` });
    expect((await handler(big)).status).toBe(413);
  });

  it("plaintext mode: echoes the url_verification challenge only with the right token", async () => {
    feishuFetch();
    const { handler } = buildChannel();
    const ok = await handler(feishuRequest({ type: "url_verification", challenge: "ch-42", token: TOKEN }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ challenge: "ch-42" });
    const bad = await handler(feishuRequest({ type: "url_verification", challenge: "ch-42", token: "forged" }));
    expect(bad.status).toBe(401);
    const missing = await handler(feishuRequest({ type: "url_verification", challenge: "ch-42" }));
    expect(missing.status).toBe(401);
  });

  it("plaintext mode: an event with a wrong header token is 401, never routed", async () => {
    feishuFetch();
    const { handler, calls } = buildChannel();
    const evt = messageEvent({ id: "om_x" });
    (evt.header as { token: string }).token = "forged";
    expect((await handler(feishuRequest(evt))).status).toBe(401);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("encrypt mode: URL challenge uses decrypt+Token; ordinary events require a raw-body signature", async () => {
    feishuFetch();
    const KEY = "enc-key";
    const { handler } = buildChannel({ encryptKey: KEY });
    const encrypt = (plain: string): string => {
      const k = createHash("sha256").update(KEY, "utf8").digest();
      const iv = randomBytes(16);
      const cipher = createCipheriv("aes-256-cbc", k, iv);
      return Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
    };
    const encryptedBody = (plain: Record<string, unknown>): string =>
      JSON.stringify({ encrypt: encrypt(JSON.stringify(plain)) });
    const headers = (sig: string) => ({
      "x-lark-request-timestamp": "170",
      "x-lark-request-nonce": "n1",
      "x-lark-signature": sig,
    });

    // Feishu explicitly excludes Request URL verification from event signature verification: the
    // encrypted challenge has no signature headers, so decrypt + constant-time Token authenticates it.
    const challengeBody = encryptedBody({ type: "url_verification", challenge: "c9", token: TOKEN });
    const challenge = await handler(new Request("http://app/feishu", { method: "POST", body: challengeBody }));
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: "c9" });
    const badTokenBody = encryptedBody({ type: "url_verification", challenge: "c9", token: "forged" });
    expect((await handler(new Request("http://app/feishu", { method: "POST", body: badTokenBody }))).status).toBe(401);
    // A supplied-but-invalid signature cannot downgrade into the unsigned challenge path.
    expect(
      (
        await handler(
          new Request("http://app/feishu", { method: "POST", body: challengeBody, headers: headers("bad") }),
        )
      ).status,
    ).toBe(401);

    const eventBody = encryptedBody({
      schema: "2.0",
      header: { event_type: "im.chat.updated_v1", token: TOKEN },
      event: {},
    });
    const signedEvent = await handler(
      new Request("http://app/feishu", {
        method: "POST",
        body: eventBody,
        headers: headers(eventSignature(KEY, "170", "n1", eventBody)),
      }),
    );
    expect(signedEvent.status).toBe(200);
    expect(
      (await handler(new Request("http://app/feishu", { method: "POST", body: eventBody, headers: headers("bad") })))
        .status,
    ).toBe(401);
    expect((await handler(new Request("http://app/feishu", { method: "POST", body: eventBody }))).status).toBe(401);
    // Encrypt Key mode remains modal: plaintext events are never accepted.
    expect((await handler(feishuRequest(messageEvent({})))).status).toBe(401);
  });

  it("ACKs (and drops) event types this channel does not consume", async () => {
    feishuFetch();
    const { handler, calls } = buildChannel();
    const res = await handler(
      feishuRequest({ schema: "2.0", header: { event_type: "im.chat.updated_v1", token: TOKEN }, event: {} }),
    );
    expect(res.status).toBe(200);
    await flush();
    expect(calls).toHaveLength(0);
  });
});

describe("upgrade from the session-mode model", () => {
  it("refuses a removed session option instead of silently changing behaviour under it", () => {
    const opts = { appId: "app", appSecret: "secret", verificationToken: TOKEN } as FeishuChannelOptions;
    expect(() => buildFeishuChannel({ ...opts, groupMessageSession: "continuous" } as never)).toThrow(
      /groupMessageSession/,
    );
    expect(() => buildFeishuChannel({ ...opts, directMessageSession: "threaded" } as never)).toThrow(
      /directMessageSession/,
    );
  });

  it("drops only the retired context buckets", async () => {
    feishuFetch();
    const root = mkdtempSync(join(tmpdir(), "feishu-upgrade-"));
    tempRoots.push(root);
    const home = join(root, "channels", "feishu");
    mkdirSync(home, { recursive: true });
    const entry = (body: string) => [{ sender: "user ou_alice", body, messageId: `om_${body}` }];
    writeFileSync(
      join(home, "buffers.json"),
      JSON.stringify({
        "oc_1:root:om_old": entry("retired"), // no place key can produce this shape any more
        "oc_1:thread:omt_live": entry("live-thread"),
        oc_1: entry("live-chat"),
      }),
    );

    const { agent } = replyingAgent();
    buildFeishuChannel({ appId: "app", appSecret: "secret", verificationToken: TOKEN, apiBaseUrl: BASE })({
      agent,
      stateRoot: root,
    });

    const buffers = JSON.parse(readFileSync(join(home, "buffers.json"), "utf8")) as Record<string, unknown[]>;
    expect(Object.keys(buffers).sort()).toEqual(["oc_1", "oc_1:thread:omt_live"]);
  });
});

describe("turn flow", () => {
  it("a direct message is one continuous conversation, answered in place", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel({}, "**bold** answer");

    expect((await handler(feishuRequest(messageEvent({ id: "om_dm1", text: "hello there" })))).status).toBe(200);
    await idle(); // settle the first turn before the second: queue cards would race for card ids
    await handler(feishuRequest(messageEvent({ id: "om_dm2", text: "and another thing" })));
    await idle();

    // Rule 3 (memory follows the place): both messages share the chat session — no per-ask session.
    expect(calls.map((call) => call.scope.session)).toEqual(["feishu:oc_1", "feishu:oc_1"]);
    // The id becomes a percent-encoded jsonl filename, so the bound that matters is the filesystem's,
    // not a round number: worst-case platform ids stay far under it.
    const worstCase = `feishu:oc_${"a".repeat(32)}:omt_${"b".repeat(32)}`;
    expect(encodeURIComponent(worstCase).length).toBeLessThan(255);
    expect(calls[0]?.prompt.text).toContain("[feishu: chat oc_1 (p2p), from user ou_alice, msg om_dm1]");
    expect(calls[0]?.prompt.text).toContain("hello there");
    // The reply contract rides every chat prompt: the channel owns delivery — no send-tool answering.
    expect(calls[0]?.prompt.text).toContain("delivered to the current chat by the channel itself");
    expect(calls[0]?.prompt.text).toContain("do not call a send tool");
    // Rule 2 (answer where asked): a plain send, neither quoted nor pushed into a thread.
    const mount = fx.calls("receive_id_type=chat_id", "POST").find((call) => call.body?.msg_type === "interactive");
    expect(mount).toBeDefined();
    expect(fx.calls("/im/v1/messages/om_dm1/reply", "POST")).toHaveLength(0);
    // The live card still streams and settles.
    const create = fx.calls("/cardkit/v1/cards", "POST")[0];
    expect(JSON.parse(String(create?.body?.data)).config.streaming_mode).toBe(true);
    const settle = fx.calls("/cardkit/v1/cards/c1", "PUT")[0];
    const settled = JSON.parse(String((settle?.body?.card as Record<string, unknown> | undefined)?.data));
    expect(settled.config.streaming_mode).toBe(false);
    expect(settled.body.elements[0].content).toBe("**bold** answer");
    expect(settled.config.summary).toEqual({ content: "bold answer" });
  });

  it("dedups an accepted message while pending and after completion, and the ring survives restart", async () => {
    feishuFetch();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let starts = 0;
    injectedAgent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        starts++;
        await gate;
        yield { type: "completed" };
      },
    };
    const first = buildChannel();
    const duplicate = messageEvent({ id: "om_dup", text: "run once" });

    expect((await first.handler(feishuRequest(duplicate))).status).toBe(200);
    await vi.waitFor(() => expect(starts).toBe(1));
    expect((await first.handler(feishuRequest(duplicate))).status).toBe(200);
    expect(starts).toBe(1); // duplicate while the original turn is still pending

    release();
    await first.idle();
    expect((await first.handler(feishuRequest(duplicate))).status).toBe(200);
    await first.idle();
    expect(starts).toBe(1); // duplicate after turns.json no longer carries the completed turn
    expect(JSON.parse(readFileSync(join(first.home, "seen.json"), "utf8"))).toContain("om_dup");

    const restarted = replyingAgent();
    const routes = buildFeishuChannel({
      appId: "app",
      appSecret: "secret",
      verificationToken: TOKEN,
      apiBaseUrl: BASE,
    })({ agent: restarted.agent, stateRoot: first.root });
    const again = routes["POST /feishu"];
    if (!again) throw new Error("expected POST /feishu");
    const idleAgain = (again as { turnsIdle?: () => Promise<void> }).turnsIdle ?? (async () => {});
    channelIdles.add(idleAgain);

    expect((await again(feishuRequest(duplicate))).status).toBe(200);
    await idleAgain();
    expect(restarted.calls).toHaveLength(0);
  });

  it("a direct message asked inside a thread is answered inside that thread", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel({}, "threaded answer");

    await handler(
      feishuRequest(messageEvent({ id: "om_dm_thread", threadId: "omt_dm", text: "continue in the topic" })),
    );
    await idle();

    // A direct message's thread is a place too: answering in the main timeline would relocate it.
    expect(calls[0]?.scope.session).toBe("feishu:oc_1:omt_dm");
    const reply = fx.calls("/im/v1/messages/om_dm_thread/reply", "POST")[0];
    expect(reply?.body?.reply_in_thread).toBe(true);
  });

  it("a direct-message reply loads its referent and stays in the chat session", async () => {
    const fx = feishuFetch({
      "/im/v1/messages/om_old": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_old",
                msg_type: "text",
                body: { content: '{"text":"earlier context"}' },
                sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
    });
    const { handler, calls, idle } = buildChannel({}, "answered");

    await handler(feishuRequest(messageEvent({ id: "om_reply", text: "about that", parentId: "om_old" })));
    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("feishu:oc_1");
    expect(calls[0]?.prompt.text).toContain("earlier context"); // the referent anchor (rung 2)
    expect(fx.calls("/im/v1/messages/om_old", "GET")).toHaveLength(1);
  });

  it("different places run concurrently while one place stays FIFO", async () => {
    feishuFetch();
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const starts: { session: string; ask: string }[] = [];
    injectedAgent = {
      async *invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
        const ask = prompt.text.includes("first") ? "first" : prompt.text.includes("second") ? "second" : "other-chat";
        starts.push({ session: scope.session, ask });
        if (ask === "first") await gate;
        yield { type: "text", delta: `answer ${ask}` };
        yield { type: "completed" };
      },
    };
    const { handler, idle } = buildChannel();

    await handler(feishuRequest(messageEvent({ id: "om_1", text: "first" })));
    await vi.waitFor(() => expect(starts.map((entry) => entry.ask)).toEqual(["first"]));
    // Same chat = same place = same session, so this queues behind the running turn.
    await handler(feishuRequest(messageEvent({ id: "om_2", text: "second" })));
    // A different chat is a different place, so it runs immediately.
    await handler(feishuRequest(messageEvent({ id: "om_3", chatId: "oc_other", text: "other-chat" })));

    await vi.waitFor(() => expect(starts.map((entry) => entry.ask)).toEqual(["first", "other-chat"]));
    expect(starts.map((entry) => entry.session)).toEqual(["feishu:oc_1", "feishu:oc_other"]);

    releaseFirst();
    await idle();
    expect(starts.map((entry) => entry.ask)).toEqual(["first", "other-chat", "second"]);
    expect(starts[2]?.session).toBe("feishu:oc_1");
  });

  it("a mount rejected with 'cardid is invalid' (cardkit→IM propagation) is retried, not degraded", async () => {
    let interactiveSends = 0;
    const fx = feishuFetch({
      "receive_id_type=chat_id": (_url, init) => {
        const body = JSON.parse(String(init.body)) as { msg_type?: string };
        if (body.msg_type === "interactive" && ++interactiveSends === 1) {
          // The field-observed rejection of a just-minted card id — heals after a short delay.
          return Response.json({ code: 230099, msg: "Bot send message to chat failed: cardid is invalid" });
        }
        return Response.json({ code: 0, msg: "ok", data: { message_id: "om_mounted" } });
      },
    });
    const { handler, idle } = buildChannel({}, "pong");
    await handler(feishuRequest(messageEvent({ id: "om_retry1", text: "ping" })));
    await idle();
    expect(interactiveSends).toBe(2); // rejected once, mounted on the retry
    // Card tier survived: the SAME card settles — no text-placeholder degrade.
    expect(fx.calls("/cardkit/v1/cards/c1", "PUT")).toHaveLength(1);
    const texts = fx.calls("receive_id_type=chat_id", "POST").filter((c) => c.body?.msg_type === "text");
    expect(texts).toHaveLength(0);
  });

  it("a group @mention is answered in the room, in the room's session", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush(); // let botInfo resolve (open_id drives the default route)
    const evt = messageEvent({
      id: "om_g1",
      chatType: "group",
      content: JSON.stringify({ text: "@_user_1 status?" }),
      mentions: [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }],
    });
    expect((await handler(feishuRequest(evt))).status).toBe(200);
    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("feishu:oc_1"); // the room's memory, shared by everyone in it
    expect(calls[0]?.prompt.text).toContain("@Bot status?");
    // Answered in place: quoted so the ask stays identifiable, but NOT pushed into a new thread.
    const reply = fx.calls("/im/v1/messages/om_g1/reply", "POST")[0];
    expect(reply?.body?.msg_type).toBe("interactive");
    expect(reply?.body?.reply_in_thread).toBeUndefined();
  });

  it("dedups unsummoned context, folds it into the next @mention, then commits it", async () => {
    feishuFetch();
    const { handler, calls, idle, home } = buildChannel();
    await flush();
    const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];
    const context = messageEvent({ id: "om_context", chatType: "group", text: "deploy failed" });

    await handler(feishuRequest(context));
    await handler(feishuRequest(context));
    expect(calls).toHaveLength(0);
    const persisted = JSON.parse(readFileSync(join(home, "buffers.json"), "utf8")) as Record<string, unknown[]>;
    expect(persisted.oc_1).toHaveLength(1);

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_context_ask",
          chatType: "group",
          text: "@_user_1 summarize",
          mentions: mention,
        }),
      ),
    );
    await idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt.text).toContain("[recent group discussion:");
    expect(calls[0]?.prompt.text).toContain("user ou_alice (msg om_context): deploy failed");

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_context_again",
          chatType: "group",
          text: "@_user_1 again",
          mentions: mention,
        }),
      ),
    );
    await idle();
    expect(calls[1]?.prompt.text).not.toContain("recent group discussion");
  });

  it("isolates a non-Agent thread's buffer and folds it only into an @mention in that thread", async () => {
    feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_foreign_context",
          chatType: "group",
          rootId: "om_foreign_root",
          threadId: "omt_foreign",
          text: "foreign-thread detail",
        }),
      ),
    );
    await handler(
      feishuRequest(messageEvent({ id: "om_main_ask", chatType: "group", text: "@_user_1 main", mentions: mention })),
    );
    await idle();
    expect(calls[0]?.prompt.text).not.toContain("foreign-thread detail");

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_foreign_ask",
          chatType: "group",
          rootId: "om_foreign_root",
          threadId: "omt_foreign",
          content: JSON.stringify({ text: "@_user_1 thread summary" }),
          mentions: mention,
        }),
      ),
    );
    await idle();
    expect(calls[1]?.prompt.text).toContain("foreign-thread detail");
  });

  // ── The participant model's summon rule (docs/design/participant-model.md §3) ────────────────────
  //
  // The agent speaks unprompted only where it takes part AND exactly one human does. Participation is
  // bootstrapped the way a user does it: @ the bot inside a thread once; every later bare message in
  // that thread addresses it.

  const BOT_MENTION = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];

  /** Join a thread the way a human does: mention the bot inside it, so the agent answers there. */
  async function joinThread(
    handler: (req: Request) => Response | Promise<Response>,
    idle: () => Promise<void>,
    threadId: string,
    id = "om_join",
  ): Promise<void> {
    await handler(
      feishuRequest(
        messageEvent({
          id,
          chatType: "group",
          threadId,
          content: JSON.stringify({ text: "@_user_1 start" }),
          mentions: BOT_MENTION,
        }),
      ),
    );
    await idle();
  }

  it("an unreadable referent still delivers the ask's own attachments", async () => {
    const fx = feishuFetch({
      "/im/v1/messages/om_gone": () =>
        Response.json({ code: 230110, msg: "Action unavailable as the message has been deleted." }),
    });
    const { handler, calls, idle } = buildChannel();

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_with_image",
          parentId: "om_gone",
          msgType: "image",
          content: JSON.stringify({ image_key: "img_1" }),
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(1);
    // The quoted message is context; the attached image is the ask. Losing the first must not lose
    // the second.
    expect(calls[0]?.prompt.images).toHaveLength(1);
    expect(calls[0]?.prompt.text).toContain("could not be read");
    expect(fx.calls("/resources/img_1", "GET")).toHaveLength(1);
  });

  it("two deliveries in one thread each observe their sender before admission, so neither is answered", async () => {
    feishuFetch();
    const { handler, calls, home } = buildChannel();
    await flush();

    // Alice and Bob both speak in a thread the agent has never answered in. Order does not matter and
    // neither does timing: the sender is recorded on the way in, before the rule is consulted.
    await Promise.all([
      handler(
        feishuRequest(
          messageEvent({ id: "om_a", chatType: "group", threadId: "omt_two", text: "alice", senderId: "ou_alice" }),
        ),
      ),
      handler(
        feishuRequest(
          messageEvent({ id: "om_b", chatType: "group", threadId: "omt_two", text: "bob", senderId: "ou_bob" }),
        ),
      ),
    ]);
    await flush();

    expect(calls).toHaveLength(0);
    const participants = JSON.parse(readFileSync(join(home, "thread-participants.json"), "utf8")) as Record<
      string,
      { humans: string[] }
    >;
    expect(participants["feishu:oc_1:omt_two"]?.humans.sort()).toEqual(["ou_alice", "ou_bob"]);
  });

  it("a bare message in a thread the agent is talking to addresses it, through the normal streaming path", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle, home } = buildChannel();
    await flush();

    await joinThread(handler, idle, "omt_two_party");
    expect(JSON.parse(readFileSync(join(home, "thread-participants.json"), "utf8"))).toHaveProperty(
      "feishu:oc_1:omt_two_party",
    );

    await handler(
      feishuRequest(
        messageEvent({ id: "om_bare", chatType: "group", threadId: "omt_two_party", text: "what about queues?" }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(2);
    // Rule 3: a thread is its own place, so both turns share the thread's session.
    expect(calls.map((call) => call.scope.session)).toEqual(["feishu:oc_1:omt_two_party", "feishu:oc_1:omt_two_party"]);
    expect(calls[1]?.prompt.text).toContain("what about queues?");
    // Nothing was asked of the platform: both halves of the rule are what this channel heard.
    expect(fx.calls("container_id_type=thread", "GET")).toHaveLength(0);
    const reply = fx.calls("/im/v1/messages/om_bare/reply", "POST")[0];
    expect(reply?.body?.msg_type).toBe("interactive");
    expect(reply?.body?.reply_in_thread).toBe(true);
    const previewCard = fx.calls("/cardkit/v1/cards", "POST")[1];
    expect(JSON.parse(String(previewCard?.body?.data)).config.streaming_mode).toBe(true);
    expect(fx.calls("/cardkit/v1/cards/c2", "PUT")).not.toHaveLength(0);
  });

  it("a second human in the thread restores the mention requirement, and the agent keeps listening", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    await joinThread(handler, idle, "omt_crowd");

    // Bob joins the side conversation: addressing is ambiguous again.
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_bob",
          chatType: "group",
          threadId: "omt_crowd",
          senderId: "ou_bob",
          text: "I think it is the cache",
        }),
      ),
    );
    await flush();
    expect(calls).toHaveLength(1); // Bob's message is discussion, not an ask
    expect(fx.calls("/im/v1/messages/om_bob/reply", "POST")).toHaveLength(0);

    // Alex's next bare message is no longer unambiguously addressed to the agent either.
    await handler(
      feishuRequest(messageEvent({ id: "om_alex2", chatType: "group", threadId: "omt_crowd", text: "so what now?" })),
    );
    await flush();
    expect(calls).toHaveLength(1);

    // An explicit mention still works, and folds the discussion it was listening to.
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_alex3",
          chatType: "group",
          threadId: "omt_crowd",
          content: JSON.stringify({ text: "@_user_1 summarize" }),
          mentions: BOT_MENTION,
        }),
      ),
    );
    await idle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt.text).toContain("I think it is the cache");
    expect(calls[1]?.prompt.text).toContain("so what now?");
  });

  it("a thread the agent never joined is discussion, however quiet it looks", async () => {
    const fx = feishuFetch();
    const { handler, calls, home } = buildChannel();
    await flush();

    // One human, no mention, and the agent has never spoken here — being a participant is the half
    // that is missing, and no amount of listening supplies it.
    for (const [id, text] of [
      ["om_h1", "first aside"],
      ["om_h2", "second aside"],
    ] as const) {
      await handler(feishuRequest(messageEvent({ id, chatType: "group", threadId: "omt_human", text })));
    }
    await flush();

    expect(calls).toHaveLength(0);
    expect(fx.calls("container_id_type=thread", "GET")).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(home, "buffers.json"), "utf8"))).toHaveProperty("oc_1:thread:omt_human");
  });

  it("a permanently failed bot identity keeps group mentions off, and the ask becomes context", async () => {
    feishuFetch({ "/bot/v3/info": () => Response.json({ code: 1, msg: "bot capability disabled" }, { status: 403 }) });
    const { handler, calls, home } = buildChannel();
    await flush(); // botInfo settles as FAILED — @mention summon stays off (warned at startup)

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_noid",
          chatType: "group",
          content: JSON.stringify({ text: "@_user_1 who am I asking?" }),
          mentions: [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }],
        }),
      ),
    );
    await flush();

    // Fail-closed: without its own identity the agent cannot tell a mention of itself from one of
    // someone else, so the message is kept as context rather than answered.
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(home, "buffers.json"), "utf8")).toContain("who am I asking?");
  });

  it("a mention landing before the bot identity resolves is kept as context, then folded into the next turn", async () => {
    let releaseBotInfo!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBotInfo = resolve;
    });
    feishuFetch({
      "/bot/v3/info": () =>
        gate.then(() =>
          Response.json({ code: 0, msg: "ok", bot: { open_id: "ou_bot", app_name: "Bot" } }),
        ) as unknown as Response,
    });
    const { handler, calls, idle } = buildChannel();
    const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];

    // Acceptance is synchronous, so it cannot wait for the identity: this one is buffered.
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_early",
          chatType: "group",
          content: JSON.stringify({ text: "@_user_1 early ask" }),
          mentions: mention,
        }),
      ),
    );
    await flush();
    expect(calls).toHaveLength(0);

    releaseBotInfo();
    await flush();
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_later",
          chatType: "group",
          content: JSON.stringify({ text: "@_user_1 later ask" }),
          mentions: mention,
        }),
      ),
    );
    await idle();

    // Delayed, never lost: the early ask arrives as context on the next answered turn in that place.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt.text).toContain("early ask");
    expect(calls[0]?.prompt.text).toContain("later ask");
  });

  it("buffers @other-only discussion in a thread; the next bare message consumes it", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    await joinThread(handler, idle, "omt_targeted");

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_for_bob",
          chatType: "group",
          threadId: "omt_targeted",
          content: JSON.stringify({ text: "@_bob please check this" }),
          mentions: [{ key: "@_bob", name: "Bob", id: { open_id: "ou_bob" } }],
        }),
      ),
    );
    await flush();
    expect(calls).toHaveLength(1); // mentioning only other people is discussion
    expect(fx.calls("/im/v1/messages/om_for_bob/reply", "POST")).toHaveLength(0);

    await handler(
      feishuRequest(
        messageEvent({ id: "om_bare_after_bob", chatType: "group", threadId: "omt_targeted", text: "status?" }),
      ),
    );
    await idle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt.text).toContain("@Bob please check this");
    expect(calls[1]?.prompt.text).toContain("status?");
  });

  it("an explicit @bot still summons when the message also mentions other people", async () => {
    feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    await joinThread(handler, idle, "omt_multi");

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_multi_ask",
          chatType: "group",
          threadId: "omt_multi",
          content: JSON.stringify({ text: "@_bob @_user_1 what do you both think?" }),
          mentions: [
            { key: "@_bob", name: "Bob", id: { open_id: "ou_bob" } },
            { key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } },
          ],
        }),
      ),
    );
    await idle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt.text).toContain("what do you both think?");
  });

  it("a thread continuation gets normal queue feedback while its session is busy", async () => {
    const fx = feishuFetch();
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let invocation = 0;
    injectedAgent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        if (++invocation === 2) await gate;
        yield { type: "text", delta: `answer ${invocation}` };
        yield { type: "completed" };
      },
    };
    const { handler, idle } = buildChannel();
    await flush();
    await joinThread(handler, idle, "omt_queue");

    await handler(
      feishuRequest(messageEvent({ id: "om_busy", chatType: "group", threadId: "omt_queue", text: "while busy" })),
    );
    await vi.waitFor(() => expect(invocation).toBe(2));
    await handler(
      feishuRequest(messageEvent({ id: "om_queued", chatType: "group", threadId: "omt_queue", text: "queued ask" })),
    );
    await flush();

    const queuedReplies = fx.calls("/im/v1/messages/om_queued/reply", "POST");
    expect(queuedReplies).toHaveLength(1);
    expect(queuedReplies[0]?.body?.reply_in_thread).toBe(true);
    expect(String(fx.calls("/cardkit/v1/cards", "POST").at(-1)?.body?.data)).toContain("Queued");

    releaseFirst();
    await idle();
    expect(invocation).toBe(3);
    expect(fx.calls("/im/v1/messages/om_queued/reply", "POST")).toHaveLength(1);
  });

  it("a thread continuation failure uses the same user-facing error path as an @mention", async () => {
    const fx = feishuFetch();
    const errors: string[] = [];
    vi.spyOn(log, "error").mockImplementation((message) => errors.push(message));
    let invocation = 0;
    injectedAgent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        if (++invocation === 2) {
          yield { type: "failed", details: "model exploded", retryable: false };
          return;
        }
        yield { type: "text", delta: "ok" };
        yield { type: "completed" };
      },
    };
    const { handler, idle } = buildChannel();
    await flush();
    await joinThread(handler, idle, "omt_fail");

    await handler(
      feishuRequest(messageEvent({ id: "om_failing", chatType: "group", threadId: "omt_fail", text: "break it" })),
    );
    await idle();

    const settle = fx.calls("/cardkit/v1/cards/c2", "PUT").at(-1);
    const settled = JSON.parse(String((settle?.body?.card as Record<string, unknown> | undefined)?.data));
    expect(String(settled.body.elements[0].content)).toMatch(/couldn’t|could not|⚠️/);
    expect(errors.some((message) => message.includes("model exploded"))).toBe(true);
  });

  it("keeps folded context after a failed thread turn and re-folds it into the retry", async () => {
    feishuFetch();
    const prompts: Prompt[] = [];
    let invocation = 0;
    injectedAgent = {
      async *invoke(_scope, prompt): AsyncIterable<AgentEvent> {
        prompts.push(prompt);
        if (++invocation === 2) {
          yield { type: "failed", details: "model failed", retryable: true };
          return;
        }
        yield { type: "text", delta: "ok" };
        yield { type: "completed" };
      },
    };
    const { handler, idle } = buildChannel();
    await flush();
    await joinThread(handler, idle, "omt_retry");

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_aside",
          chatType: "group",
          threadId: "omt_retry",
          content: JSON.stringify({ text: "@_bob unrelated aside" }),
          mentions: [{ key: "@_bob", name: "Bob", id: { open_id: "ou_bob" } }],
        }),
      ),
    );
    await handler(
      feishuRequest(messageEvent({ id: "om_fails", chatType: "group", threadId: "omt_retry", text: "first try" })),
    );
    await idle();
    expect(prompts[1]?.text).toContain("unrelated aside");

    // The failed turn did not consume the context: the next turn still sees it.
    await handler(
      feishuRequest(messageEvent({ id: "om_retry", chatType: "group", threadId: "omt_retry", text: "second try" })),
    );
    await idle();
    expect(prompts[2]?.text).toContain("unrelated aside");
    expect(prompts[2]?.text).toContain("second try");
  });

  it("leaves context arriving during a thread turn for the next continuation", async () => {
    feishuFetch();
    const prompts: Prompt[] = [];
    let invocation = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    injectedAgent = {
      async *invoke(_scope, prompt): AsyncIterable<AgentEvent> {
        prompts.push(prompt);
        if (++invocation === 2) {
          markStarted();
          await gate;
        }
        yield { type: "text", delta: "ok" };
        yield { type: "completed" };
      },
    };
    const { handler, idle } = buildChannel();
    await flush();
    await joinThread(handler, idle, "omt_inflight");

    await handler(
      feishuRequest(messageEvent({ id: "om_running", chatType: "group", threadId: "omt_inflight", text: "run" })),
    );
    await started;
    // Arrives while the turn is running: it must survive for the NEXT answered turn.
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_midflight",
          chatType: "group",
          threadId: "omt_inflight",
          content: JSON.stringify({ text: "@_bob mid-flight note" }),
          mentions: [{ key: "@_bob", name: "Bob", id: { open_id: "ou_bob" } }],
        }),
      ),
    );
    await flush();
    release();
    await idle();
    expect(prompts[1]?.text).not.toContain("mid-flight note");

    await handler(
      feishuRequest(messageEvent({ id: "om_next", chatType: "group", threadId: "omt_inflight", text: "next" })),
    );
    await idle();
    expect(prompts[2]?.text).toContain("mid-flight note");
  });

  it("buffers an unmentioned message in a thread the agent takes no part in", async () => {
    const fx = feishuFetch();
    const { handler, calls, home } = buildChannel();
    await flush();

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_unowned",
          chatType: "group",
          threadId: "omt_unowned",
          text: "ordinary discussion",
        }),
      ),
    );
    await flush();

    expect(calls).toHaveLength(0);
    expect(fx.calls("/im/v1/messages/om_unowned/reply", "POST")).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(home, "buffers.json"), "utf8"))).toHaveProperty("oc_1:thread:omt_unowned");
  });

  it("an @mention inside a thread is answered there, in that thread's session", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_group_followup",
          chatType: "group",
          threadId: "omt_group",
          parentId: "om_group_parent",
          content: JSON.stringify({ text: "@_user_1 continue" }),
          mentions: [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }],
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("feishu:oc_1:omt_group");
    const reply = fx.calls("/im/v1/messages/om_group_followup/reply", "POST")[0];
    expect(reply?.body?.reply_in_thread).toBe(true);
  });

  it("a group summon answers in the room's session; inside a thread, in the thread's session", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_group_continuous",
          chatType: "group",
          content: JSON.stringify({ text: "@_user_1 top level" }),
          mentions: mention,
        }),
      ),
    );
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_group_topic",
          chatType: "group",
          rootId: "om_group_old_root",
          threadId: "omt_existing",
          content: JSON.stringify({ text: "@_user_1 existing topic" }),
          mentions: mention,
        }),
      ),
    );
    await idle();

    expect(calls.map((call) => call.scope.session)).toEqual(["feishu:oc_1", "feishu:oc_1:omt_existing"]);
    const topReply = fx.calls("/im/v1/messages/om_group_continuous/reply", "POST")[0];
    expect(topReply?.body?.reply_in_thread).toBeUndefined();
    const topicReply = fx.calls("/im/v1/messages/om_group_topic/reply", "POST")[0];
    expect(topicReply?.body?.reply_in_thread).toBe(true);
  });

  it("keeps an over-card continuation inside a topic", async () => {
    const fx = feishuFetch();
    const { handler, idle } = buildChannel({}, "x".repeat(25 * 1024));
    await flush();
    const evt = messageEvent({
      id: "om_topic",
      chatType: "group",
      threadId: "omt_1",
      content: JSON.stringify({ text: "@_user_1 explain" }),
      mentions: [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }],
    });

    await handler(feishuRequest(evt));
    await idle();

    const topicReplies = fx.calls("/im/v1/messages/om_topic/reply", "POST");
    expect(topicReplies.some((c) => c.body?.msg_type === "interactive")).toBe(true); // mounted preview
    const continuations = topicReplies.filter((c) => c.body?.msg_type === "text");
    expect(continuations.length).toBeGreaterThan(0);
    expect(continuations.every((c) => c.body?.reply_in_thread === true)).toBe(true);
    const leaked = fx
      .calls("receive_id_type=chat_id", "POST")
      .filter((c) => c.body?.msg_type === "text" && c.body.receive_id === "oc_1");
    expect(leaked).toHaveLength(0);
  });

  it("does not delete a settled card or resend the full answer when a later continuation fails", async () => {
    let textSends = 0;
    const fx = feishuFetch({
      "receive_id_type=chat_id": (_url, init) => {
        const body = JSON.parse(String(init.body)) as { msg_type?: string };
        if (body.msg_type !== "text") {
          return Response.json({ code: 0, msg: "ok", data: { message_id: "om_mounted" } });
        }
        textSends++;
        return textSends === 2
          ? Response.json({ code: 230001, msg: "continuation rejected" })
          : Response.json({ code: 0, msg: "ok", data: { message_id: `om_text_${textSends}` } });
      },
    });
    const fullAnswer = "x".repeat(70 * 1024);
    const { handler, idle } = buildChannel({}, fullAnswer);

    await handler(feishuRequest(messageEvent({ id: "om_continuation_failure" })));
    await idle();

    expect(fx.calls("/cardkit/v1/cards/c1", "PUT")).toHaveLength(1); // settle succeeded
    const continuations = fx.calls("receive_id_type=chat_id", "POST").filter((c) => c.body?.msg_type === "text");
    expect(continuations).toHaveLength(2); // first landed, second failed; no full-answer fallback send
    expect(fx.calls("/im/v1/messages/om_mounted", "DELETE")).toHaveLength(0);
    expect(
      continuations.some((c) => {
        const sent = JSON.parse(String(c.body?.content)) as { text?: string };
        return sent.text === fullAnswer;
      }),
    ).toBe(false);
  });

  it("attributes buffered vision images after primary images in prompt order", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_background_image",
          chatType: "group",
          msgType: "image",
          content: JSON.stringify({ image_key: "background_image" }),
        }),
      ),
    );
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_image_ask",
          chatType: "group",
          msgType: "post",
          content: JSON.stringify({
            content: [
              [
                { tag: "at", user_name: "Bot", user_id: "ou_bot" },
                { tag: "text", text: " compare these " },
                { tag: "img", image_key: "primary_image" },
              ],
            ],
          }),
          mentions: mention,
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt.images).toHaveLength(2);
    expect(calls[0]?.prompt.text).toContain("background vision images from earlier discussion");
    expect(calls[0]?.prompt.text).toContain("appended after 1 primary image(s)");
    expect(calls[0]?.prompt.text).toContain("vision image 2: from user ou_alice, msg om_background_image");
    expect(fx.calls("/im/v1/messages/om_image_ask/resources/primary_image", "GET")).toHaveLength(1);
    expect(fx.calls("/im/v1/messages/om_background_image/resources/background_image", "GET")).toHaveLength(1);
  });

  it("a failed buffered attachment degrades per resource while readable siblings still load", async () => {
    const fx = feishuFetch({
      "/resources/stale": () => Response.json({ code: 234001, msg: "resource expired" }, { status: 410 }),
    });
    const { handler, calls, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_stale_file",
          chatType: "group",
          msgType: "file",
          content: JSON.stringify({ file_key: "stale", file_name: "stale.txt" }),
        }),
      ),
    );
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_good_file",
          chatType: "group",
          msgType: "file",
          content: JSON.stringify({ file_key: "good", file_name: "good.txt" }),
        }),
      ),
    );
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_file_ask",
          chatType: "group",
          content: JSON.stringify({ text: "@_bot summarize the files" }),
          mentions: mention,
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt.text).toContain("1 attachment(s) from the earlier discussion are not loaded");
    expect(calls[0]?.prompt.text).toContain("- good.txt (from user ou_alice, msg om_good_file, earlier discussion)");
    expect(fx.calls("/resources/stale", "GET")).toHaveLength(1);
    expect(fx.calls("/resources/good", "GET")).toHaveLength(1);
  });

  it("group without a mention is buffered without invoking", async () => {
    feishuFetch();
    const { handler, calls } = buildChannel();
    await flush();
    expect((await handler(feishuRequest(messageEvent({ id: "om_g2", chatType: "group" }))))?.status).toBe(200);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("a failed turn surfaces the onError text through the terminal write (default: neutral)", async () => {
    const fx = feishuFetch();
    injectedAgent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "failed", details: "boom: engine exploded", retryable: false };
      },
    };
    const { handler, idle } = buildChannel({ onError: (f) => `⚠️ ${f.details}` });
    await handler(feishuRequest(messageEvent({ id: "om_f1" })));
    await idle();
    const settle = fx.calls("/cardkit/v1/cards/c1", "PUT")[0];
    const settled = JSON.parse(String((settle?.body?.card as Record<string, unknown> | undefined)?.data));
    expect(settled.body.elements[0].content).toBe("⚠️ boom: engine exploded");
  });

  it("logs terminal-notice delivery failures without replacing the Agent/stream failure", async () => {
    const errors: string[] = [];
    vi.spyOn(log, "error").mockImplementation((message) => errors.push(message));
    const scenarios: { id: string; agent: Agent; delivery: string; primary: string }[] = [
      {
        id: "om_failed_delivery",
        agent: {
          async *invoke(): AsyncIterable<AgentEvent> {
            yield { type: "failed", details: "engine exploded", retryable: false };
          },
        },
        delivery: "failed to deliver the agent-failure notice",
        primary: "agent failed: engine exploded",
      },
      {
        id: "om_abnormal_delivery",
        agent: {
          invoke(): AsyncIterable<AgentEvent> {
            return {
              [Symbol.asyncIterator]() {
                return {
                  next: async (): Promise<IteratorResult<AgentEvent>> => {
                    throw new Error("stream exploded");
                  },
                };
              },
            };
          },
        },
        delivery: "failed to deliver the abnormal-turn notice",
        primary: "stream exploded",
      },
    ];

    for (const scenario of scenarios) {
      feishuFetch({
        "/cardkit/v1/cards/c1": () => Response.json({ code: 200850, msg: "card expired" }),
        "receive_id_type=chat_id": (_url, init) => {
          const body = JSON.parse(String(init.body)) as { msg_type?: string };
          return body.msg_type === "text"
            ? Response.json({ code: 230001, msg: "terminal send rejected" })
            : Response.json({ code: 0, msg: "ok", data: { message_id: "om_mounted" } });
        },
      });
      injectedAgent = scenario.agent;
      const { handler, idle } = buildChannel();
      await handler(feishuRequest(messageEvent({ id: scenario.id })));
      await idle();
      expect(errors.some((line) => line.includes(scenario.delivery) && line.includes("terminal send rejected"))).toBe(
        true,
      );
      expect(errors.some((line) => line.includes(scenario.primary))).toBe(true);
    }
  });

  it("degrades to a TEXT placeholder when the card tier fails, and settles via ONE edit", async () => {
    const fx = feishuFetch({
      "/cardkit/v1/cards": () => Response.json({ code: 200860, msg: "card too big" }),
    });
    const { handler, idle } = buildChannel({}, "plain answer");
    await handler(feishuRequest(messageEvent({ id: "om_t1" })));
    await idle();
    // Fallback: a text placeholder message, then the final answer lands as an EDIT of it.
    const sends = fx.calls("receive_id_type=chat_id", "POST");
    expect(sends[0]?.body?.msg_type).toBe("text");
    const edit = fx.calls("/im/v1/messages/om_bot_1", "PUT")[0];
    expect(JSON.parse(String(edit?.body?.content))).toEqual({ text: "plain answer" });
  });

  it("resolves attachments: an image message reaches the agent as a vision image", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await handler(feishuRequest(messageEvent({ id: "om_img", msgType: "image", content: '{"image_key":"k9"}' })));
    await idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt.images).toEqual([
      { mimeType: "image/png", data: Buffer.from("img-bytes").toString("base64") },
    ]);
    expect(fx.calls("/im/v1/messages/om_img/resources/k9").length).toBe(1);
  });

  it("a mention-only deployment always loads the quoted message, since it never heard the thread", async () => {
    // The anchor skips the quote because "the session already holds it" — true only where the channel
    // RECEIVED the messages in between. Without the delivery scope only @mentions arrive, so a quote of
    // a message that was never delivered would be dropped with nothing in its place.
    const fx = feishuFetch({
      "/im/v1/messages/om_quoted": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_quoted",
                msg_type: "text",
                body: { content: '{"text":"the quoted plan"}' },
                sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
    });
    const { handler, calls, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];

    // First mention makes the agent a participant of the thread.
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_first",
          chatType: "group",
          threadId: "omt_q",
          content: JSON.stringify({ text: "@_user_1 start" }),
          mentions: mention,
        }),
      ),
    );
    await idle();

    // A later mention quoting a message the app was never delivered.
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_second",
          chatType: "group",
          threadId: "omt_q",
          parentId: "om_quoted",
          content: JSON.stringify({ text: "@_user_1 what about this?" }),
          mentions: mention,
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(2);
    expect(fx.calls("/im/v1/messages/om_quoted", "GET")).toHaveLength(1);
    expect(calls[1]?.prompt.text).toContain("the quoted plan");
  });

  it("resolves a reply summon's referent: fetches the parent, injects its text, downloads its file", async () => {
    const fx = feishuFetch({
      "/im/v1/messages/om_parent": (url) =>
        // The needle also matches the parent's RESOURCE download URL — route that to bytes.
        url.includes("/resources/")
          ? new Response(Buffer.from("pdf-bytes"), { status: 200, headers: { "content-type": "application/pdf" } })
          : Response.json({
              code: 0,
              msg: "ok",
              data: {
                items: [
                  {
                    message_id: "om_parent",
                    msg_type: "file",
                    body: { content: '{"file_key":"fk1","file_name":"spec.pdf"}' },
                    sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
                  },
                ],
              },
            }),
    });
    const { handler, calls, home, idle } = buildChannel();
    await handler(feishuRequest(messageEvent({ id: "om_r1", text: "summarize this", parentId: "om_parent" })));
    await idle();
    expect(calls).toHaveLength(1);
    const prompt = calls[0]?.prompt.text ?? "";
    expect(prompt).toContain("[replied-to message (msg om_parent, from user ou_bob): [file: spec.pdf]]");
    expect(prompt).toContain("attached files — read them with your tools");
    expect(prompt).toContain("spec.pdf");
    expect(fx.calls("/im/v1/messages/om_parent/resources/fk1").length).toBe(1);
    expect(readFileSync(join(home, "files", "oc_1", "spec.pdf")).toString()).toBe("pdf-bytes");
  });

  it("rejects a primary non-image referent without a reader and does not download or invoke", async () => {
    const fx = feishuFetch({
      "/im/v1/messages/om_parent_no_reader": (url) =>
        url.includes("/resources/")
          ? new Response(Buffer.from("must-not-download"), { status: 200 })
          : Response.json({
              code: 0,
              msg: "ok",
              data: {
                items: [
                  {
                    message_id: "om_parent_no_reader",
                    msg_type: "file",
                    body: { content: '{"file_key":"fk1","file_name":"spec.pdf"}' },
                    sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
                  },
                ],
              },
            }),
    });
    const { handler, calls, idle } = buildChannel({
      canReadLocalFiles: false,
      onError: (failed) => failed.details,
    });
    await handler(
      feishuRequest(messageEvent({ id: "om_no_reader", text: "summarize this", parentId: "om_parent_no_reader" })),
    );
    await idle();
    expect(calls).toHaveLength(0);
    expect(fx.calls("/im/v1/messages/om_parent_no_reader/resources/fk1")).toHaveLength(0);
  });

  it("a thread opened on the agent's own card reads that card AND the chain up to the ask", async () => {
    // Three halves of pointer resolution. The card is READ (its own answers are cards, so a follow-up
    // on one used to quote a bare `[interactive message]` marker); it is attributed to the agent
    // itself; and the chain above it is walked to its root — the ask the card answered — so the model
    // sees the exchange the user is pointing INTO, not just its last link.
    const fx = feishuFetch({
      "/im/v1/messages/om_bot_card": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_bot_card",
                msg_type: "interactive",
                parent_id: "om_original_ask", // the chain's next link — walked
                body: {
                  content: JSON.stringify({
                    elements: [[{ tag: "text", text: "确认后我会给出方案；批准后再实现 SVG 足球页面。" }]],
                  }),
                },
                sender: { id: "cli_self", id_type: "app_id", sender_type: "app" }, // THIS app
              },
            ],
          },
        }),
      "/im/v1/messages/om_original_ask": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_original_ask",
                msg_type: "text",
                body: { content: JSON.stringify({ text: "加一个新的页面，用 svg 构建一个足球的页面" }) },
                sender: { id: "ou_alice", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
    });
    const { handler, calls, idle } = buildChannel({ appId: "cli_self" });
    await flush(); // the group mention only matches once bot/v3/info has resolved this bot's open_id
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_in_topic",
          chatType: "group",
          threadId: "omt_on_card",
          parentId: "om_bot_card",
          content: JSON.stringify({ text: "@_user_1 这个新页面放到 test/下" }),
          mentions: BOT_MENTION,
        }),
      ),
    );
    await idle();

    const prompt = calls[0]?.prompt.text ?? "";
    expect(prompt).toContain("SVG 足球页面"); // the card is READ, not reported as unreadable
    expect(prompt).not.toContain("[interactive message]");
    expect(prompt).toContain("from you, the agent"); // its own message, not "user cli_self"
    // the ask arrives as the chain above the card, reaching its root
    expect(prompt).toContain("[reply chain above it, oldest first:");
    expect(prompt).toContain("(msg om_original_ask, from user ou_alice): 加一个新的页面，用 svg 构建一个足球的页面");
    expect(fx.calls("/im/v1/messages/om_original_ask", "GET")).toHaveLength(1);
    // …and the scope names the thread's LINEAGE: the room it branched from, plus the ids that can
    // locate the branch point in the room's session — the referent (whose id is unfindable there:
    // the card was sent after its turn) and then the chain, whose ids DID pass through room turns.
    expect(calls[0]?.scope.session).toBe("feishu:oc_1:omt_on_card");
    expect(calls[0]?.scope.parentSession).toBe("feishu:oc_1");
    expect(calls[0]?.scope.branchHints).toEqual(["om_bot_card", "om_original_ask"]);
  });

  it("a main-timeline turn carries no lineage — the room branched from nothing", async () => {
    feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await handler(feishuRequest(messageEvent({ id: "om_plain", text: "hello" })));
    await idle();
    expect(calls[0]?.scope.session).toBe("feishu:oc_1");
    expect(calls[0]?.scope.parentSession).toBeUndefined();
    expect(calls[0]?.scope.branchHints).toBeUndefined();
  });

  it("a thread's FIRST turn folds the room's un-answered discussion — read-only, and once", async () => {
    // The fork (scope.parentSession) carries what the room's SESSION knew; chatter since the room's
    // last answered turn sits only in its context buffer, absorbed by nothing. The thread's first
    // turn folds that bucket — read-only, so the room's own next answered turn still delivers the
    // same messages to its own memory. Each place sees the discussion exactly once.
    //
    // ONCE, not per turn: a prompt lands in the session, so turn two's context already holds turn
    // one's fold. Re-folding would put a second identical copy of the block, and of its images, in
    // one context window.
    feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];
    // Two un-summoned ROOM messages → the main bucket.
    await handler(feishuRequest(messageEvent({ id: "om_room1", chatType: "group", text: "我们该用蓝色背景" })));
    await handler(feishuRequest(messageEvent({ id: "om_room2", chatType: "group", text: "同意，蓝色好" })));
    // First message of a NEW topic summons the agent.
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_t1",
          chatType: "group",
          threadId: "omt_new",
          content: JSON.stringify({ text: "@_bot 背景色定了吗？" }),
          mentions: mention,
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(1);
    const first = calls[0]?.prompt.text ?? "";
    expect(first).toContain("[recent discussion in the room this thread branched from — not yet answered there:");
    expect(first).toContain("蓝色背景");
    expect(first).toContain("同意，蓝色好");

    // A SECOND thread turn does NOT fold it again: the agent has answered here, and the block is
    // already in this session from turn one.
    await handler(
      feishuRequest(messageEvent({ id: "om_t2", chatType: "group", threadId: "omt_new", text: "那用深蓝还是浅蓝" })),
    );
    await idle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt.text ?? "").not.toContain("branched from");

    // …and the ROOM's own next answered turn still folds AND commits the same chatter: the thread
    // only peeked, so nothing was stolen from the room.
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_room_ask",
          chatType: "group",
          content: JSON.stringify({ text: "@_bot 总结一下大家的意见" }),
          mentions: mention,
        }),
      ),
    );
    await idle();
    expect(calls).toHaveLength(3);
    const roomTurn = calls[2]?.prompt.text ?? "";
    expect(roomTurn).toContain("[recent group discussion:");
    expect(roomTurn).toContain("蓝色背景");
  });

  it("the room fold's attachments ride the buffered tier into the thread's first turn — once", async () => {
    // The fold is prompt text plus real attachments — the room's image crosses as an image, not as a
    // marker line. This is what a session-bound seed could not do, and it is also what makes the
    // first-turn gate load-bearing rather than an optimisation: an image re-sent on every turn would
    // sit in one context window several times over, reading as several separate postings, and would
    // be re-fetched from the platform each time.
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_room_img",
          chatType: "group",
          msgType: "image",
          content: JSON.stringify({ image_key: "room_shot" }),
        }),
      ),
    );
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_t_first",
          chatType: "group",
          threadId: "omt_pic",
          content: JSON.stringify({ text: "@_bot 那张图里是什么" }),
          mentions: mention,
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(1);
    const prompt = calls[0]?.prompt.text ?? "";
    expect(prompt).toContain("branched from"); // the fold is there…
    expect(calls[0]?.prompt.images).toHaveLength(1); // …and the image crossed with it
    expect(prompt).toContain("vision image 1: from user ou_alice, msg om_room_img");
    expect(fx.calls("/im/v1/messages/om_room_img/resources/room_shot", "GET")).toHaveLength(1);

    // A later turn in the same thread neither re-fetches it nor re-attaches it: one copy in the
    // session is the whole point, and the model must not see the same screenshot twice.
    await handler(
      feishuRequest(messageEvent({ id: "om_t_second", chatType: "group", threadId: "omt_pic", text: "还有别的吗" })),
    );
    await idle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt.images ?? []).toHaveLength(0);
    expect(fx.calls("/im/v1/messages/om_room_img/resources/room_shot", "GET")).toHaveLength(1);
  });

  it("a ROUTED session is opaque: no lineage, even when its id looks like a place key", async () => {
    // route().session's contract is opaque. A three-segment id like "tenant:user:alice" must not be
    // re-parsed as `<kind>:<chat>:<thread>` — that would let a thread message inherit from a session
    // ("tenant:user") that belongs to someone else entirely: cross-session injection.
    feishuFetch();
    const { handler, calls, idle } = buildChannel({
      route: () => ({ session: "tenant:user:alice" }),
    });
    await handler(
      feishuRequest(messageEvent({ id: "om_routed", threadId: "omt_x", parentId: "om_root", text: "in a topic" })),
    );
    await idle();
    expect(calls[0]?.scope.session).toBe("tenant:user:alice");
    expect(calls[0]?.scope.parentSession).toBeUndefined(); // opaque — never split
    expect(calls[0]?.scope.branchHints).toBeUndefined();
  });

  it("another BOT's message is not the agent's own: no self-attribution, chain still walked", async () => {
    // A group can hold several bots, so `sender_type === "app"` answers "some app", not "this app".
    // Matching on it alone would tell the model it wrote a message it never sent. The identity
    // compared is the app id the sender carries. The chain walks through the stranger's message all
    // the same — it is the platform's structure, not a conversation the agent took part in.
    const fx = feishuFetch({
      "/im/v1/messages/om_other_bot": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_other_bot",
                msg_type: "interactive",
                parent_id: "om_stranger_ask", // no shared prefix with om_other_bot — feishuFetch matches by substring
                body: { content: JSON.stringify({ elements: [[{ tag: "text", text: "another bot's card" }]] }) },
                sender: { id: "cli_someone_else", id_type: "app_id", sender_type: "app" },
              },
            ],
          },
        }),
      "/im/v1/messages/om_stranger_ask": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_stranger_ask",
                msg_type: "text",
                body: { content: JSON.stringify({ text: "what the other bot answered" }) },
                sender: { id: "ou_carol", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
    });
    const { handler, calls, idle } = buildChannel({ appId: "cli_self" });
    await handler(feishuRequest(messageEvent({ id: "om_o1", text: "what is this", parentId: "om_other_bot" })));
    await idle();

    const prompt = calls[0]?.prompt.text ?? "";
    expect(prompt).toContain("another bot's card"); // still decoded — the card branch is identity-blind
    expect(prompt).not.toContain("you, the agent"); // …but not claimed as its own
    expect(prompt).toContain("from app cli_someone_else"); // an app is not a person either
    expect(prompt).toContain("(msg om_stranger_ask, from user ou_carol): what the other bot answered");
    expect(fx.calls("/im/v1/messages/om_stranger_ask", "GET")).toHaveLength(1);
  });

  it("resolves a reply chain to its root, capped visibly at 8 ancestors", async () => {
    // The chain's natural bound is the platform's root; the cap is an IO guard. When it trips, the
    // block SAYS the chain continues — a silent cut would read as the root.
    const chainMsg = (id: string, text: string, parentId?: string) => () =>
      Response.json({
        code: 0,
        msg: "ok",
        data: {
          items: [
            {
              message_id: id,
              msg_type: "text",
              ...(parentId ? { parent_id: parentId } : {}),
              body: { content: JSON.stringify({ text }) },
              sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
            },
          ],
        },
      });
    const routes: Record<string, () => Response> = {};
    // om_c0 (the referent) … om_c9: each replies to the next — 9 ancestors above the referent.
    for (let i = 0; i <= 9; i++)
      routes[`/im/v1/messages/om_c${i}`] = chainMsg(`om_c${i}`, `hop ${i}`, i < 9 ? `om_c${i + 1}` : undefined);
    const fx = feishuFetch(routes);
    const { handler, calls, idle } = buildChannel();
    await handler(feishuRequest(messageEvent({ id: "om_q1", text: "context?", parentId: "om_c0" })));
    await idle();

    const prompt = calls[0]?.prompt.text ?? "";
    expect(prompt).toContain("[replied-to message (msg om_c0, from user ou_bob): hop 0]");
    expect(prompt).toContain("(…the chain continues above this point)");
    expect(prompt).toContain("(msg om_c8, from user ou_bob): hop 8"); // the 8th ancestor made it
    expect(prompt).not.toContain("hop 9"); // the 9th did not…
    expect(fx.calls("/im/v1/messages/om_c9", "GET")).toHaveLength(0); // …and was never fetched
    // oldest first: the deepest fetched ancestor renders before the referent's immediate parent
    expect(prompt.indexOf("hop 8")).toBeLessThan(prompt.indexOf("hop 1"));
  });

  it("a reply-chain cycle terminates, and a chain ancestor's image rides the buffered tier", async () => {
    // Two boundaries in one walk. The cycle guard: om_r replies to om_s which replies back to om_r —
    // corrupt platform data must end the walk, not the process. And the ancestor's image: chain
    // attachments are CONTEXT, so they load on the buffered path (attributed in the manifest), never
    // as primary inputs.
    const fx = feishuFetch({
      // Resource routes FIRST: a resource URL contains its message path as a prefix, and feishuFetch
      // matches by substring in insertion order — a message route listed earlier would intercept it.
      "/resources/chain_img": () =>
        new Response(Buffer.from("img-bytes"), { status: 200, headers: { "content-type": "image/png" } }),
      "/im/v1/messages/om_r": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_r",
                msg_type: "text",
                parent_id: "om_s",
                body: { content: JSON.stringify({ text: "the quoted reply" }) },
                sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
      "/im/v1/messages/om_s": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_s",
                msg_type: "image",
                parent_id: "om_r", // the cycle
                body: { content: JSON.stringify({ image_key: "chain_img" }) },
                sender: { id: "ou_alice", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
    });
    const { handler, calls, idle } = buildChannel();
    await handler(feishuRequest(messageEvent({ id: "om_q2", text: "what image?", parentId: "om_r" })));
    await idle();

    // fetched once — the cycle ended the walk (the resources fetch shares the URL prefix, so exclude it)
    const msgFetches = fx.calls("/im/v1/messages/om_s", "GET").filter((c) => !c.url.includes("/resources/"));
    expect(msgFetches).toHaveLength(1);
    const prompt = calls[0]?.prompt.text ?? "";
    expect(prompt).toContain("(msg om_s, from user ou_alice): [image]");
    // a cycle ends SHORT of a root — the block must not read as complete
    expect(prompt).toContain("(…the chain continues above this point)");
    // the image itself arrived through the buffered path, attributed to its chain position
    expect(prompt).toContain("vision image 1: from user ou_alice, msg om_s");
    expect(calls[0]?.prompt.images).toHaveLength(1);
    expect(fx.calls("/im/v1/messages/om_s/resources/chain_img", "GET")).toHaveLength(1);
  });

  it("an unloadable chain-ancestor attachment costs a note, never the turn", async () => {
    // The referent's own resources are primary (fail-fast: the user pointed at them). A chain
    // ancestor's are not — nobody pointed at them — so losing one degrades exactly like a buffered
    // attachment: the turn runs and the model is told what is missing.
    const fx = feishuFetch({
      // Resource route FIRST — see the cycle test for why insertion order matters here.
      "/resources/gone_img": () => Response.json({ code: 234001, msg: "resource expired" }, { status: 410 }),
      "/im/v1/messages/om_t": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_t",
                msg_type: "text",
                parent_id: "om_u",
                body: { content: JSON.stringify({ text: "about that picture" }) },
                sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
      "/im/v1/messages/om_u": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_u",
                msg_type: "image",
                body: { content: JSON.stringify({ image_key: "gone_img" }) },
                sender: { id: "ou_alice", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
    });
    const { handler, calls, idle } = buildChannel();
    await handler(feishuRequest(messageEvent({ id: "om_q3", text: "that pic?", parentId: "om_t" })));
    await idle();

    expect(calls).toHaveLength(1); // the turn ran — a chain attachment is never primary
    const prompt = calls[0]?.prompt.text ?? "";
    expect(prompt).toContain("(msg om_u, from user ou_alice): [image]");
    expect(prompt).toContain("1 attachment(s) from the earlier discussion are not loaded");
    expect(calls[0]?.prompt.images ?? []).toHaveLength(0);
    expect(fx.calls("/resources/gone_img", "GET")).toHaveLength(1);
  });

  it("an unreadable chain ancestor ends the walk with the fetched part kept", async () => {
    const fx = feishuFetch({
      "/im/v1/messages/om_v": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_v",
                msg_type: "text",
                parent_id: "om_w",
                body: { content: JSON.stringify({ text: "quoted" }) },
                sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
      "/im/v1/messages/om_w": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_w",
                msg_type: "text",
                parent_id: "om_gone", // resolves to an empty item list — deleted or invisible
                body: { content: JSON.stringify({ text: "still here" }) },
                sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
      // om_gone: the default GET handler answers { items: [] }
    });
    const { handler, calls, idle } = buildChannel();
    await handler(feishuRequest(messageEvent({ id: "om_q4", text: "context?", parentId: "om_v" })));
    await idle();

    const prompt = calls[0]?.prompt.text ?? "";
    expect(prompt).toContain("(msg om_w, from user ou_bob): still here"); // the fetched part is kept
    // The cut is VISIBLE but neutral: the block must not read as if om_w were the root — the model
    // would take it for the original ask — yet the marker names no id and no error detail.
    expect(prompt).toContain("(…the chain continues above this point)");
    expect(prompt).not.toContain("om_gone");
    expect(fx.calls("/im/v1/messages/om_gone", "GET")).toHaveLength(1); // tried, then stopped
  });

  it("the chain's text shares one referent-sized budget, cut visibly from the far end", async () => {
    // Ancestors are context, not the ask: the whole chain spends at most one further
    // REFERENT_MAX_CODE_POINTS. A wall-of-text ancestor exhausts it, the walk stops — saving the
    // fetches too — and the same truncation line keeps the cut from reading as the root.
    const fx = feishuFetch({
      "/im/v1/messages/om_e0": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_e0",
                msg_type: "text",
                parent_id: "om_e1",
                body: { content: JSON.stringify({ text: "quoted" }) },
                sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
      "/im/v1/messages/om_e1": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_e1",
                msg_type: "text",
                parent_id: "om_e2",
                body: { content: JSON.stringify({ text: "w".repeat(5000) }) }, // > the whole budget
                sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
      "/im/v1/messages/om_e2": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_e2",
                msg_type: "text",
                body: { content: JSON.stringify({ text: "beyond the budget" }) },
                sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
    });
    const { handler, calls, idle } = buildChannel();
    await handler(feishuRequest(messageEvent({ id: "om_q5", text: "context?", parentId: "om_e0" })));
    await idle();

    const prompt = calls[0]?.prompt.text ?? "";
    expect(prompt).toContain("(…the chain continues above this point)");
    expect(prompt).not.toContain("beyond the budget");
    expect(fx.calls("/im/v1/messages/om_e2", "GET")).toHaveLength(0); // the budget also stops the IO
  });

  it("chain attachments obey the buffered tier's cap, with chain refs taking slots first", async () => {
    // BUFFERED means the whole tier contract, cap included: chain ancestors and the context buffer
    // share ONE budget of BUFFER_ATTACH_MAX images. Chain refs outrank buffer refs (the direct
    // upstream of what the user pointed at beats ambient discussion), and whatever the cap drops is
    // counted into the note — the model must not hold references it silently cannot see.
    const fx = feishuFetch({
      // Resource routes FIRST — a resource URL contains its message path as a prefix (see the cycle
      // test), and these must serve BYTES, not the message JSON.
      "/resources/chain_a": () =>
        new Response(Buffer.from("img-bytes"), { status: 200, headers: { "content-type": "image/png" } }),
      "/resources/chain_b": () =>
        new Response(Buffer.from("img-bytes"), { status: 200, headers: { "content-type": "image/png" } }),
      "/im/v1/messages/om_g1": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_g1",
                msg_type: "post",
                body: {
                  content: JSON.stringify({
                    content: [
                      [
                        { tag: "text", text: "two shots " },
                        { tag: "img", image_key: "chain_a" },
                        { tag: "img", image_key: "chain_b" },
                      ],
                    ],
                  }),
                },
                sender: { id: "ou_carol", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
      "/im/v1/messages/om_g0": () =>
        Response.json({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_g0",
                msg_type: "text",
                parent_id: "om_g1",
                body: { content: JSON.stringify({ text: "see the shots above" }) },
                sender: { id: "ou_bob", id_type: "open_id", sender_type: "user" },
              },
            ],
          },
        }),
    });
    const { handler, calls, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];
    // Two un-summoned group images land in the context buffer…
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_buf1",
          chatType: "group",
          msgType: "image",
          content: JSON.stringify({ image_key: "buf_one" }),
        }),
      ),
    );
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_buf2",
          chatType: "group",
          msgType: "image",
          content: JSON.stringify({ image_key: "buf_two" }),
        }),
      ),
    );
    // …then a reply summon whose chain ancestor carries two more. 4 background refs, budget 3.
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_g_ask",
          chatType: "group",
          parentId: "om_g0",
          content: JSON.stringify({ text: "@_bot what do the shots show" }),
          mentions: mention,
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(1);
    const prompt = calls[0]?.prompt.text ?? "";
    expect(calls[0]?.prompt.images).toHaveLength(3); // the tier's cap, not 4
    expect(prompt).toContain("1 attachment(s) from the earlier discussion are not loaded");
    // chain first: both chain images made it, one buffered image was dropped
    expect(fx.calls("/im/v1/messages/om_g1/resources/chain_a", "GET")).toHaveLength(1);
    expect(fx.calls("/im/v1/messages/om_g1/resources/chain_b", "GET")).toHaveLength(1);
    const bufferFetches = [
      ...fx.calls("/im/v1/messages/om_buf1/resources/buf_one", "GET"),
      ...fx.calls("/im/v1/messages/om_buf2/resources/buf_two", "GET"),
    ];
    expect(bufferFetches).toHaveLength(1);
  });

  it("a custom route's null remains a full ignore and does not enter the default context buffer", async () => {
    feishuFetch();
    const { handler, calls, home } = buildChannel({ route: () => null });

    await handler(feishuRequest(messageEvent({ id: "om_custom_ignore", chatType: "group", text: "ignore me" })));
    await flush();

    expect(calls).toHaveLength(0);
    expect(existsSync(join(home, "buffers.json"))).toBe(false);
  });

  it("a sender with no id flavour counts as a distinct speaker per message, warned once", async () => {
    feishuFetch();
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));
    const { handler, calls, home, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];

    // The agent is summoned by an unattributable human and answers, joining the thread.
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_x1",
          chatType: "group",
          threadId: "omt_anon",
          senderId: null,
          content: JSON.stringify({ text: "@_user_1 take a look" }),
          mentions: mention,
        }),
      ),
    );
    await idle();
    expect(calls).toHaveLength(1);

    // A second unattributable message. It MAY be the same person, but nothing can say so — counting
    // them as one would be the under-count that makes the agent speak into a crowd.
    await handler(
      feishuRequest(
        messageEvent({ id: "om_x2", chatType: "group", threadId: "omt_anon", senderId: null, text: "bare follow-up" }),
      ),
    );
    await idle();

    const participants = JSON.parse(readFileSync(join(home, "thread-participants.json"), "utf8")) as Record<
      string,
      { agentSpoke: boolean; humans: string[] }
    >;
    const heard = participants["feishu:oc_1:omt_anon"];
    expect(heard?.agentSpoke).toBe(true);
    expect(heard?.humans).toHaveLength(2); // per MESSAGE, not per thread
    expect(new Set(heard?.humans).size).toBe(2);

    // …so the bare follow-up was NOT answered, and the thread now requires a mention.
    expect(calls).toHaveLength(1);
    // One line for a systemic condition, not one per message.
    expect(warnings.filter((message) => message.includes("no usable id"))).toHaveLength(1);
  });

  it("a route supplying its own session leaves a BYSTANDER record — the thread's session never held the turn", async () => {
    feishuFetch();
    const { handler, calls, home, idle } = buildChannel({ route: () => ({ session: "user:ou_alice" }) });

    await handler(
      feishuRequest(messageEvent({ id: "om_rs", chatType: "group", threadId: "omt_rs", text: "routed elsewhere" })),
    );
    await idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("user:ou_alice");

    // `agentSpoke` would claim the thread's own session remembers this turn. It does not — the answer
    // went to a per-user session — so the summon rule must not see it here. The human is still
    // recorded: what was heard is heard.
    const participants = JSON.parse(readFileSync(join(home, "thread-participants.json"), "utf8")) as Record<
      string,
      { agentSpoke: boolean; humans: string[] }
    >;
    expect(participants["feishu:oc_1:omt_rs"]).toEqual({ agentSpoke: false, humans: ["ou_alice"] });
  });

  it("a custom route still records a COMPLETE participation record, since a deployment can drop the route", async () => {
    const fx = feishuFetch();
    const { handler, calls, home, idle } = buildChannel({ route: () => ({}) });

    await handler(
      feishuRequest(messageEvent({ id: "om_custom_group", chatType: "group", threadId: "omt_custom", text: "custom" })),
    );
    await idle();

    expect(calls).toHaveLength(1);
    // The route decided admission, so the built-in thread rule never ran — and nothing is asked of the
    // platform either way.
    expect(fx.calls("container_id_type=thread", "GET")).toHaveLength(0);
    // Both halves are recorded regardless. Nothing reads this record while the route is installed, but
    // a route is configuration and the record outlives a change to it — gating on it would leave
    // `agentSpoke` on disk with the intervening humans missing (see thread-participants.ts).
    const participants = JSON.parse(readFileSync(join(home, "thread-participants.json"), "utf8")) as Record<
      string,
      { agentSpoke: boolean; humans: string[] }
    >;
    expect(participants["feishu:oc_1:omt_custom"]).toEqual({ agentSpoke: true, humans: ["ou_alice"] });
  });

  it("a custom route's empty text runs NO turn (nothing to say, nothing to load)", async () => {
    feishuFetch();
    const { handler, calls, idle } = buildChannel({ route: () => ({ text: "  " }) });
    await handler(feishuRequest(messageEvent({ id: "om_e1" })));
    await idle();
    expect(calls).toHaveLength(0);
  });

  it("recovers a crash-surviving turn from the store on the next start (L1 replay)", async () => {
    feishuFetch();
    const root = mkdtempSync(join(tmpdir(), "feishu-recover-"));
    tempRoots.push(root);
    const home = join(root, "channels", "feishu");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "turns.json"),
      JSON.stringify({
        om_lost: {
          id: "om_lost",
          seq: 1,
          session: "oc_9",
          baseText: "what a prior run never finished",
          bufferKey: "oc_9",
          chatId: "oc_9",
          images: [],
          files: [],
          attempts: 1,
        },
      }),
    );
    const { agent, calls } = replyingAgent("recovered");
    const handler = buildFeishuChannel({ appId: "a", appSecret: "s", verificationToken: TOKEN, apiBaseUrl: BASE })({
      agent,
      stateRoot: root,
    })["POST /feishu"];
    const idle = (handler as unknown as { turnsIdle?: () => Promise<void> })?.turnsIdle;
    if (idle) channelIdles.add(idle);
    await idle?.();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt.text).toContain("what a prior run never finished");
    // The replayed turn completed → its intent is gone from disk.
    expect(JSON.parse(readFileSync(join(home, "turns.json"), "utf8"))).toEqual({});
  });

  it("keeps queued asks FIFO and takes over each ask's reply-quoted queue card in place", async () => {
    const fx = feishuFetch();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const order: string[] = [];
    let invocation = 0;
    injectedAgent = {
      async *invoke(_s: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
        const ask = ["first", "second", "third"].find((x) => prompt.text.includes(`\n${x}`)) ?? "unknown";
        order.push(ask);
        if (++invocation === 1) await gate;
        yield { type: "text", delta: `answer ${ask}` };
        yield { type: "completed" };
      },
    };
    const { handler, idle } = buildChannel(); // one p2p chat session
    await handler(feishuRequest(messageEvent({ id: "om_q1", text: "first" })));
    await flush(); // first turn parks on the gate with its preview mounted
    await handler(feishuRequest(messageEvent({ id: "om_q2", text: "second" })));
    await handler(feishuRequest(messageEvent({ id: "om_q3", text: "third" })));

    // Each queued turn mounts ONE queue-status card as a reply to ITS source message — even in p2p,
    // where an ordinary immediate answer is intentionally unquoted. The two mounts may finish in either
    // visual order; the quote is the stable attribution.
    const queueCardFor = (messageId: string): string | undefined => {
      const mount = fx
        .calls(`/im/v1/messages/${messageId}/reply`, "POST")
        .find((c) => c.body?.msg_type === "interactive");
      const content = JSON.parse(String(mount?.body?.content)) as { data?: { card_id?: string } };
      return content.data?.card_id;
    };
    await vi.waitFor(() => {
      expect(queueCardFor("om_q2")).toBeDefined();
      expect(queueCardFor("om_q3")).toBeDefined();
    });
    const secondCard = queueCardFor("om_q2") as string;
    const thirdCard = queueCardFor("om_q3") as string;
    expect(secondCard).not.toBe(thirdCard);
    const queueCreates = fx.calls("/cardkit/v1/cards", "POST").filter((c) => {
      const card = JSON.parse(String(c.body?.data)) as { body?: { elements?: { content?: string }[] } };
      return card.body?.elements?.[0]?.content?.includes("⏳ Queued");
    });
    expect(queueCreates).toHaveLength(2);

    release();
    await idle();

    // The per-session queue is FIFO, and each final answer settles the SAME card entity that carried
    // that ask's queue status: no new preview, no recalled-message tombstone.
    expect(order).toEqual(["first", "second", "third"]);
    expect(fx.calls("/cardkit/v1/cards", "POST")).toHaveLength(3); // one entity per turn, not queue+answer
    for (const [cardId, answer] of [
      [secondCard, "answer second"],
      [thirdCard, "answer third"],
    ] as const) {
      const settle = fx
        .calls(`/cardkit/v1/cards/${cardId}`, "PUT")
        .find((c) => c.url.endsWith(`/cardkit/v1/cards/${cardId}`));
      const card = JSON.parse(String((settle?.body?.card as Record<string, unknown> | undefined)?.data));
      expect(card.body.elements[0].content).toBe(answer);
    }
    expect(fx.calls("/im/v1/messages/", "DELETE")).toHaveLength(0);
  });

  it("an explicitly delayed queue frame may be skipped on FAST turnover without a recall tombstone", async () => {
    // Immediate is the default; an author may opt into a delay to suppress Queue on very short waits.
    // If the wait ends inside that configured delay, no status card was mounted and nothing is recalled.
    const fx = feishuFetch();
    const { handler, idle } = buildChannel({
      queueNoticeDelayMs: 5_000,
    });
    await handler(feishuRequest(messageEvent({ id: "om_f1", text: "first" })));
    await handler(feishuRequest(messageEvent({ id: "om_f2", text: "second" }))); // queues behind, arms the mount
    await idle(); // both turns complete well inside the queue-status delay
    const queueCreates = fx.calls("/cardkit/v1/cards", "POST").filter((c) => {
      const card = JSON.parse(String(c.body?.data)) as { body?: { elements?: { content?: string }[] } };
      return card.body?.elements?.[0]?.content?.includes("⏳ Queued");
    });
    expect(queueCreates).toHaveLength(0);
    expect(fx.calls("/im/v1/messages/", "DELETE")).toHaveLength(0);
  });
});

describe("the Lark compatibility profile", () => {
  it("reuses the Feishu engine with its own route, state, envelope, p2p mode, and log brand", async () => {
    const fx = feishuFetch();
    const info: string[] = [];
    vi.spyOn(log, "info").mockImplementation((message) => info.push(message));
    const root = mkdtempSync(join(tmpdir(), "lark-state-"));
    tempRoots.push(root);
    const { agent, calls } = replyingAgent("pong");
    const routes = larkChannel({
      appId: "app",
      appSecret: "secret",
      verificationToken: TOKEN,
      apiBaseUrl: BASE,
    })({ agent, stateRoot: root });
    expect(routes["POST /feishu"]).toBeUndefined();
    const handler = routes["POST /lark"];
    if (!handler) throw new Error("expected POST /lark");
    const maybeIdle = (handler as { turnsIdle?: () => Promise<void> }).turnsIdle;
    if (maybeIdle) channelIdles.add(maybeIdle);
    const res = await handler(feishuRequest(messageEvent({ id: "om_lark1", text: "ping" })));
    expect(res.status).toBe(200);
    await maybeIdle?.();
    expect(calls[0]?.prompt.text).toContain("[lark: chat oc_1 (p2p)");
    // The lark-branded assembly path carries the same reply contract as canonical feishu.
    expect(calls[0]?.prompt.text).toContain("delivered to the current chat by the channel itself");
    expect(calls[0]?.scope.session).toBe("lark:oc_1"); // branded per channel, not per engine
    // A direct message is answered in place: a plain send, not a quoted thread reply.
    const mount = fx.calls("receive_id_type=chat_id", "POST").find((call) => call.body?.msg_type === "interactive");
    expect(mount).toBeDefined();
    expect(fx.calls("/im/v1/messages/om_lark1/reply", "POST")).toHaveLength(0);
    expect(info.some((line) => line.startsWith("[lark] turn start:"))).toBe(true);
    expect(existsSync(join(root, "channels", "lark"))).toBe(true);
    expect(existsSync(join(root, "channels", "feishu"))).toBe(false);
  });

  it("mount failures name each public factory", () => {
    const ctx = { agent: {} as Agent, stateRoot: "/tmp/unused-feishu-factory-name" };
    expect(() => buildFeishuChannel({ appId: "", appSecret: "s", verificationToken: "t" })(ctx)).toThrow(
      /feishuChannel/,
    );
    expect(() => larkChannel({ appId: "", appSecret: "s", verificationToken: "t" })(ctx)).toThrow(/larkChannel/);
  });
});

describe("cardSummary: the settled card's chat-list/notification preview", () => {
  it("takes the first meaningful line as plain text", () => {
    expect(cardSummary("# Heading\n\nbody")).toBe("Heading");
    expect(cardSummary("```js\ncode();\n```\nThe **answer** is [here](https://x)")).toBe("The answer is here");
    expect(cardSummary("- first bullet\n- second")).toBe("first bullet");
  });

  it("caps the length by code point and survives empty/whitespace answers", () => {
    const long = "x".repeat(200);
    expect(cardSummary(long).length).toBeLessThanOrEqual(60);
    expect(cardSummary(long).endsWith("…")).toBe(true);
    const emojiBoundary = cardSummary(`${"a".repeat(58)}😀xy`);
    expect(Array.from(emojiBoundary)).toHaveLength(60);
    expect(emojiBoundary).toContain("😀");
    expect(Buffer.from(emojiBoundary, "utf8").toString("utf8")).toBe(emojiBoundary);
    expect(cardSummary("   \n  ")).toBe("");
  });
});

describe("feishu stop command", () => {
  const fakeControl = (result: { ok: true } | { code: string }) => {
    const dispatched: { session: string; command: SessionCommand }[] = [];
    const control = {
      dispatch: async (session: string, command: SessionCommand) => {
        dispatched.push({ session, command });
        return "ok" in result
          ? { ok: true as const }
          : { ok: false as const, error: { code: result.code, message: "no run", retryable: false } };
      },
    } as unknown as SessionControl;
    return { control, dispatched };
  };

  it("aborts the session, replies, and never submits a turn (mention-stripped match)", async () => {
    feishuFetch();
    const { control, dispatched } = fakeControl({ ok: true });
    const { handler, calls, idle } = buildChannel({ control });
    const evt = messageEvent({ id: "om_stop", text: "Stop." });
    expect((await handler(feishuRequest(evt))).status).toBe(200);
    await flush();
    await idle();
    expect(dispatched).toEqual([{ session: "feishu:oc_1", command: { type: "abort" } }]);
    expect(calls).toHaveLength(0); // a control action, never a turn
  });

  it("no hub degrades to the visible not-enabled notice; 'stop it' stays a normal turn", async () => {
    const net = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    expect((await handler(feishuRequest(messageEvent({ id: "om_s1", text: "stop" })))).status).toBe(200);
    expect((await handler(feishuRequest(messageEvent({ id: "om_s2", text: "stop it" })))).status).toBe(200);
    await flush();
    await idle();
    expect(calls).toHaveLength(1); // only "stop it" became a turn
    const bodies = net.calls("/im/v1/messages", "POST").map((c) => JSON.stringify(c.body));
    expect(bodies.some((b) => b.includes("Stop isn't enabled"))).toBe(true);
  });
});
