import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelContext } from "../../../src/channels/context.ts";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { type Agent, type ErrorCode, agentError } from "../../../src/agent-api.ts";
import { type FeishuChannelOptions, feishuChannel as buildFeishuChannel } from "../../../src/feishu.ts";
import { larkChannel } from "../../../src/lark.ts";
import { eventSignature } from "../../../src/channels/feishu/crypto.ts";
import { log } from "../../../src/log.ts";
import { type ScriptedAgent, stoppedRun, withStop } from "../../doubles/scripted-agent.ts";
import { createChannelSandbox, flushFetchMock, replyingAgent } from "../../harnesses/channel-harness.ts";

const TOKEN = "verif-token";
const BASE = "http://feishu.test";

const sandbox = createChannelSandbox("feishu-state-");
const flush = flushFetchMock;

/**
 * The platform's side of a chat's history: every message an event delivers and every message the channel sends lands
 * here, and `GET /im/v1/messages` lists it the way the platform does (newest first; an ordinary group's chat listing
 * holds a thread's root, not its replies).
 */
interface PlatformMessage {
  message_id: string;
  chat_id: string;
  thread_id?: string;
  root_id?: string;
  parent_id?: string;
  msg_type: string;
  create_time: string;
  body: { content: string };
  mentions?: unknown[];
  sender: { id: string; id_type: string; sender_type: string };
}
const platform: PlatformMessage[] = [];
let platformClock = 1_700_000_000_000;
/** File a message (once per id) and return the create_time the platform stamped it with. */
function platformAdd(message: Omit<PlatformMessage, "create_time">): string {
  const filed = platform.find((m) => m.message_id === message.message_id);
  if (filed) return filed.create_time;
  const createTime = String(++platformClock);
  platform.push({ ...message, create_time: createTime });
  return createTime;
}

afterEach(async () => {
  platform.length = 0;
  await sandbox.drainAndClean();
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
      const id = `om_bot_${++msgId}`;
      if (method === "POST") {
        // Where the platform files a reply: under its parent, inside the parent's thread (or the one it opens).
        const parentId = /\/im\/v1\/messages\/([^/]+)\/reply/.exec(url)?.[1];
        const parent = platform.find((m) => m.message_id === parentId);
        const thread =
          parent && body?.reply_in_thread === true ? (parent.thread_id ?? `omt_${parent.message_id}`) : undefined;
        if (parent && thread && parent.thread_id === undefined) parent.thread_id = thread;
        const chatId = parent?.chat_id ?? (body?.receive_id as string | undefined);
        if (chatId) {
          platformAdd({
            message_id: id,
            chat_id: chatId,
            ...(thread ? { thread_id: thread, root_id: parent?.root_id ?? parent?.message_id } : {}),
            ...(parent ? { parent_id: parent.message_id } : {}),
            msg_type: String(body?.msg_type ?? "text"),
            body: { content: String(body?.content ?? "") },
            sender: { id: "app", id_type: "app_id", sender_type: "app" },
          });
        }
      }
      return Response.json({ code: 0, msg: "ok", data: { message_id: id } });
    }
    if (/\/im\/v1\/messages\?/.test(url) && method === "GET") {
      const query = new URL(url).searchParams;
      const id = query.get("container_id");
      const items = platform
        .filter((m) =>
          query.get("container_id_type") === "thread"
            ? m.thread_id === id
            : m.chat_id === id && !(m.thread_id !== undefined && m.root_id !== undefined),
        )
        .reverse();
      const size = Number(query.get("page_size") ?? 20);
      return Response.json({
        code: 0,
        msg: "ok",
        data: { items: items.slice(0, size), has_more: items.length > size },
      });
    }
    if (url.includes("/members")) {
      return Response.json({
        code: 0,
        msg: "ok",
        data: {
          items: [
            { member_id: "ou_alice", name: "Alice" },
            { member_id: "ou_bob", name: "Bob" },
          ],
          has_more: false,
        },
      });
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
  opts: Partial<FeishuChannelOptions> & {
    stopped?: (session: string) => { stopped: string[] };
    /** State the channel finds in its home when it mounts, as an earlier run left it. */
    seed?: (home: string) => void;
  } = {},
  agentReply = "the answer",
) {
  const { stopped, seed, ...channelOpts } = opts;
  const root = sandbox.freshRoot();
  if (seed) {
    mkdirSync(join(root, "channels", "feishu"), { recursive: true });
    seed(join(root, "channels", "feishu"));
  }
  const { agent, calls } = replyingAgent(agentReply);
  const chosen = opts2Agent(opts) ?? agent;
  const protocol: ScriptedAgent = stopped ? { ...chosen, ...withStop(chosen, stopped) } : chosen;
  const routes = buildFeishuChannel({
    appId: "app",
    appSecret: "secret",
    verificationToken: TOKEN,
    apiBaseUrl: BASE,
    ...channelOpts,
  })(channelContext(protocol, root, "feishu"));
  const handler = routes["POST /feishu"];
  if (!handler) throw new Error("expected POST /feishu");
  const idle = sandbox.trackIdle(handler);
  return { handler, agent, protocol, calls, root, home: join(root, "channels", "feishu"), idle };
}
/** The conversation a session talks for, as the channel in `home` recorded it. */
function conversationOf(home: string, sessionId: string | undefined): string | undefined {
  const recorded = JSON.parse(readFileSync(join(home, "sessions.json"), "utf8"));
  return Object.entries(recorded as Record<string, string>).find(([, id]) => id === sessionId)?.[0];
}

// buildChannel accepts a custom agent through opts via this side-channel to keep the signature small.
let injectedAgent: ScriptedAgent | undefined;
function opts2Agent(_opts: unknown): ScriptedAgent | undefined {
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
  const senderId = over.senderId === null ? undefined : (over.senderId ?? "ou_alice");
  const createTime = platformAdd({
    message_id: over.id ?? "om_1",
    chat_id: over.chatId ?? "oc_1",
    ...(over.threadId ? { thread_id: over.threadId } : {}),
    ...(over.rootId ? { root_id: over.rootId } : {}),
    ...(over.parentId ? { parent_id: over.parentId } : {}),
    msg_type: over.msgType ?? "text",
    body: { content: over.content ?? JSON.stringify({ text: over.text ?? "hi" }) },
    ...(over.mentions ? { mentions: over.mentions } : {}),
    sender: { id: senderId ?? "", id_type: "open_id", sender_type: over.senderType ?? "user" },
  });
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
        create_time: createTime,
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

describe("construction fails closed", () => {
  it("requires appId/appSecret/verificationToken at mount (metadata remains inspectable before secrets exist)", () => {
    const ctx = channelContext({} as Agent, "/tmp/unused-feishu-construction", "feishu");
    expect(() => buildFeishuChannel({ appId: "", appSecret: "s", verificationToken: "t" })(ctx)).toThrow(/appId/);
    // `start` with nothing set reaches this through the scaffold: the error names both ways out.
    expect(() => buildFeishuChannel({ appId: "a", appSecret: "s", verificationToken: "" })(ctx)).toThrow(
      /receives by webhook .*`fastagent channels setup feishu --ingress webhook` captures FEISHU_VERIFICATION_TOKEN.*channels\.<name>\.ingress to "connection"/,
    );
    expect(() => larkChannel({ appId: "a", appSecret: "s", verificationToken: "" })(ctx)).toThrow(
      /LARK_VERIFICATION_TOKEN.*channels\.<name>\.ingress to "connection"/,
    );
  });
});

describe("ingress verification", () => {
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
    // A real (fresh) timestamp: the ingress refuses a signed event outside the replay window, so a
    // fixed epoch constant here would only ever exercise that rejection.
    const TS = String(Math.floor(Date.now() / 1000));
    const headers = (sig: string, ts = TS) => ({
      "x-lark-request-timestamp": ts,
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
        headers: headers(eventSignature(KEY, TS, "n1", eventBody)),
      }),
    );
    expect(signedEvent.status).toBe(200);
    expect(
      (await handler(new Request("http://app/feishu", { method: "POST", body: eventBody, headers: headers("bad") })))
        .status,
    ).toBe(401);

    // The platform retries a failed push at 15s / 5min / 1h / 6h, and it is not established whether a
    // retry is re-signed. The last one in that chain MUST still be accepted — refusing it would turn a
    // transient fault into a permanently lost user message.
    const lastRetry = String(Math.floor(Date.now() / 1000) - 6 * 60 * 60);
    expect(
      (
        await handler(
          new Request("http://app/feishu", {
            method: "POST",
            body: eventBody,
            headers: headers(eventSignature(KEY, lastRetry, "n1", eventBody), lastRetry),
          }),
        )
      ).status,
    ).toBe(200);
    // Past the retry chain a VALID signature over a stale timestamp is refused: the signature commits
    // to the timestamp, it does not make it recent, and the bounded `seen` ring is not a replay defence.
    for (const skew of [-8 * 60 * 60, 8 * 60 * 60]) {
      const stale = String(Math.floor(Date.now() / 1000) + skew);
      const res = await handler(
        new Request("http://app/feishu", {
          method: "POST",
          body: eventBody,
          headers: headers(eventSignature(KEY, stale, "n1", eventBody), stale),
        }),
      );
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("stale signature");
    }
    expect((await handler(new Request("http://app/feishu", { method: "POST", body: eventBody }))).status).toBe(401);
    // Encrypt Key mode remains modal: plaintext events are never accepted.
    expect((await handler(feishuRequest(messageEvent({})))).status).toBe(401);
  });
});

describe("turn flow", () => {
  it("a direct message is one continuous conversation, answered in place", async () => {
    const fx = feishuFetch();
    const { handler, home, calls, idle } = buildChannel({}, "**bold** answer");

    expect((await handler(feishuRequest(messageEvent({ id: "om_dm1", text: "hello there" })))).status).toBe(200);
    await idle(); // settle the first turn before the second: queue cards would race for card ids
    await handler(feishuRequest(messageEvent({ id: "om_dm2", text: "and another thing" })));
    await idle();

    // Rule 3 (memory follows the place): both messages share the chat session — no per-ask session.
    expect(calls.map((call) => conversationOf(home, call.sessionId))).toEqual(["feishu:oc_1", "feishu:oc_1"]);
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

  it("folds the chat's unanswered discussion into the next @mention, by name, once", async () => {
    feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];
    const context = messageEvent({ id: "om_context", chatType: "group", text: "deploy failed" });

    await handler(feishuRequest(context));
    expect(calls).toHaveLength(0);

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
    expect(calls[0]?.prompt.text).toContain("[recent discussion here:");
    expect(calls[0]?.prompt.text).toContain("Alice (msg om_context): deploy failed");
    // The ask is the turn's own text, not discussion.
    expect(calls[0]?.prompt.text).not.toContain("(msg om_context_ask)");

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
    // Read since the last answer: the first ask and its answer are already in the session.
    expect(calls[1]?.prompt.text).not.toContain("recent discussion here");
  });

  // ── The participant model's summon rule ────────────────────
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
    expect(calls.map((call) => conversationOf(home, call.sessionId))).toEqual([
      "feishu:oc_1:omt_two_party",
      "feishu:oc_1:omt_two_party",
    ]);
    expect(calls[1]?.prompt.text).toContain("what about queues?");
    // The rule asked nothing of the platform (both halves are what this channel heard): the only thread reads are
    // each turn's history read.
    expect(fx.calls("container_id_type=thread", "GET")).toHaveLength(calls.length);
    const reply = fx.calls("/im/v1/messages/om_bare/reply", "POST")[0];
    expect(reply?.body?.msg_type).toBe("interactive");
    expect(reply?.body?.reply_in_thread).toBe(true);
    const previewCard = fx.calls("/cardkit/v1/cards", "POST")[1];
    expect(JSON.parse(String(previewCard?.body?.data)).config.streaming_mode).toBe(true);
    expect(fx.calls("/cardkit/v1/cards/c2", "PUT")).not.toHaveLength(0);
  });
});

describe("a group's main timeline is a session per sender (Feishu)", () => {
  const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];
  const ask = (id: string, text: string, sender: string | null, over: Record<string, unknown> = {}) =>
    messageEvent({
      id,
      chatType: "group",
      text: `@_user_1 ${text}`,
      mentions: mention,
      senderId: sender,
      ...over,
    });

  it("gives each sender a session of their own, and a topic one for everyone in it", async () => {
    feishuFetch();
    const { handler, home, idle } = buildChannel();
    await flush();
    await handler(feishuRequest(ask("om_1", "one", "ou_alice")));
    await handler(feishuRequest(ask("om_2", "two", "ou_bob")));
    await handler(feishuRequest(ask("om_3", "in a topic", "ou_alice", { threadId: "omt_1" })));
    await handler(feishuRequest(ask("om_4", "same topic", "ou_bob", { threadId: "omt_1" })));
    await handler(feishuRequest(messageEvent({ id: "om_5", chatType: "p2p", text: "private", senderId: "ou_alice" })));
    await idle();
    const keys = Object.keys(JSON.parse(readFileSync(join(home, "sessions.json"), "utf8"))).sort();
    expect(keys).toEqual(
      [
        "feishu:oc_1#ou_alice",
        "feishu:oc_1#ou_bob",
        "feishu:oc_1:omt_1",
        "feishu:oc_1", // the private chat: one session for the chat
      ].sort(),
    );
  });
});

describe("the Lark compatibility profile", () => {
  it("reuses the Feishu engine with its own route, state, envelope, p2p mode, and log brand", async () => {
    const fx = feishuFetch();
    const info: string[] = [];
    vi.spyOn(log, "info").mockImplementation((message) => info.push(message));
    const root = sandbox.freshRoot();
    const { agent, calls } = replyingAgent("pong");
    const routes = larkChannel({
      appId: "app",
      appSecret: "secret",
      verificationToken: TOKEN,
      apiBaseUrl: BASE,
    })(channelContext(agent, root, "lark"));
    expect(routes["POST /feishu"]).toBeUndefined();
    const handler = routes["POST /lark"];
    if (!handler) throw new Error("expected POST /lark");
    const maybeIdle = sandbox.trackIdle(handler);
    const res = await handler(feishuRequest(messageEvent({ id: "om_lark1", text: "ping" })));
    expect(res.status).toBe(200);
    await maybeIdle();
    expect(calls[0]?.prompt.text).toContain("[lark: chat oc_1 (p2p)");
    // The lark-branded assembly path carries the same reply contract as canonical feishu.
    expect(calls[0]?.prompt.text).toContain("delivered to the current chat by the channel itself");
    expect(conversationOf(join(root, "channels", "lark"), calls[0]?.sessionId)).toBe("lark:oc_1"); // its own state
    // A direct message is answered in place: a plain send, not a quoted thread reply.
    const mount = fx.calls("receive_id_type=chat_id", "POST").find((call) => call.body?.msg_type === "interactive");
    expect(mount).toBeDefined();
    expect(fx.calls("/im/v1/messages/om_lark1/reply", "POST")).toHaveLength(0);
    expect(info.some((line) => line.startsWith("[lark] turn start:"))).toBe(true);
    expect(existsSync(join(root, "channels", "lark"))).toBe(true);
    expect(existsSync(join(root, "channels", "feishu"))).toBe(false);
  });
});

describe("feishu stop command", () => {
  /** What `abort` answers: a run it stopped, nothing running, or a refusal. */
  const fakeStop = (result: "stopped" | "idle" | ErrorCode) => {
    const aborted: string[] = [];
    const stopped = (session: string): { stopped: string[] } => {
      aborted.push(session);
      if (result === "stopped") return stoppedRun;
      if (result === "idle") return { stopped: [] };
      throw agentError(result, "no run");
    };
    return { stopped, aborted };
  };

  it("aborts the session, replies, and never submits a turn (mention-stripped match)", async () => {
    feishuFetch();
    const { stopped, aborted } = fakeStop("stopped");
    const { handler, calls, idle, home } = buildChannel({ stopped });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "sessions.json"), JSON.stringify({ "feishu:oc_1": "session-chat" }));
    const evt = messageEvent({ id: "om_stop", text: "Stop." });
    expect((await handler(feishuRequest(evt))).status).toBe(200);
    await flush();
    await idle();
    expect(aborted).toEqual(["session-chat"]);
    expect(calls).toHaveLength(0); // a control action, never a turn
  });
});
