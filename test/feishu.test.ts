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
function feishuFetch(overrides: Partial<Record<string, (url: string, init: RequestInit) => Response>> = {}) {
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
  opts: Partial<FeishuChannelOptions> & { control?: SessionControl } = {},
  agentReply = "the answer",
) {
  const { control, ...channelOpts } = opts;
  const root = mkdtempSync(join(tmpdir(), "feishu-state-"));
  tempRoots.push(root);
  const { agent, calls } = replyingAgent(agentReply);
  const routes = buildFeishuChannel({
    appId: "app",
    appSecret: "secret",
    verificationToken: TOKEN,
    baseUrl: BASE,
    ...channelOpts,
  })({ agent: opts2Agent(opts) ?? agent, stateRoot: root, control });
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
  parentId?: string;
  rootId?: string;
  threadId?: string;
}) {
  return {
    schema: "2.0",
    header: { event_id: `ev_${over.id ?? "1"}`, event_type: "im.message.receive_v1", token: TOKEN },
    event: {
      sender: { sender_type: over.senderType ?? "user", sender_id: { open_id: "ou_alice" } },
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

describe("construction fails closed", () => {
  it("requires appId/appSecret/verificationToken at mount (metadata remains inspectable before secrets exist)", () => {
    const ctx = { agent: {} as Agent, stateRoot: "/tmp/unused-feishu-construction" };
    expect(() => buildFeishuChannel({ appId: "", appSecret: "s", verificationToken: "t" })(ctx)).toThrow(/appId/);
    expect(() => buildFeishuChannel({ appId: "a", appSecret: "s", verificationToken: "" })(ctx)).toThrow(
      /verificationToken/,
    );
    expect(() =>
      buildFeishuChannel({
        appId: "a",
        appSecret: "s",
        verificationToken: "t",
        directMessageSession: "invalid" as "threaded",
      }),
    ).toThrow(/directMessageSession/);
    expect(() =>
      buildFeishuChannel({
        appId: "a",
        appSecret: "s",
        verificationToken: "t",
        groupMessageSession: "invalid" as "threaded",
      }),
    ).toThrow(/groupMessageSession/);
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

describe("turn flow", () => {
  it("p2p defaults to a provider-safe threaded session and settles the reply card inside it", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel({}, "**bold** answer");
    const rootId = "om_x100b6a42a87c88a4c3f418624276242";

    expect((await handler(feishuRequest(messageEvent({ id: rootId, text: "hello there" })))).status).toBe(200);
    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe(`feishu:${rootId}`);
    expect(encodeURIComponent(calls[0]?.scope.session ?? "").length).toBeLessThanOrEqual(64);
    expect(calls[0]?.prompt.text).toContain("[feishu: chat oc_1 (p2p), from user ou_alice]");
    expect(calls[0]?.prompt.text).toContain("hello there");
    expect(calls[0]?.prompt.text).toContain("standard Markdown");
    const create = fx.calls("/cardkit/v1/cards", "POST")[0];
    expect(JSON.parse(String(create?.body?.data)).config.streaming_mode).toBe(true);
    const mount = fx
      .calls(`/im/v1/messages/${rootId}/reply`, "POST")
      .find((call) => call.body?.msg_type === "interactive");
    expect(mount?.body?.reply_in_thread).toBe(true);
    expect(JSON.parse(String(mount?.body?.content))).toEqual({ type: "card", data: { card_id: "c1" } });
    expect(
      fx.calls("receive_id_type=chat_id", "POST").filter((call) => call.body?.msg_type === "interactive"),
    ).toHaveLength(0);
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
      baseUrl: BASE,
    })({ agent: restarted.agent, stateRoot: first.root });
    const again = routes["POST /feishu"];
    if (!again) throw new Error("expected POST /feishu");
    const idleAgain = (again as { turnsIdle?: () => Promise<void> }).turnsIdle ?? (async () => {});
    channelIdles.add(idleAgain);

    expect((await again(feishuRequest(duplicate))).status).toBe(200);
    await idleAgain();
    expect(restarted.calls).toHaveLength(0);
  });

  it("continuous p2p remains an explicit opt-out with one chat session and an ordinary send", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel({ directMessageSession: "continuous" }, "continuous answer");

    await handler(feishuRequest(messageEvent({ id: "om_continuous", text: "same chat" })));
    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("oc_1");
    const mount = fx.calls("receive_id_type=chat_id", "POST").find((call) => call.body?.msg_type === "interactive");
    expect(mount).toBeDefined();
    expect(fx.calls("/im/v1/messages/om_continuous/reply", "POST")).toHaveLength(0);
  });

  it("threaded p2p: a continuation returns to the root session without reloading its parent", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel({}, "continued");

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_followup",
          text: "continue",
          rootId: "om_root",
          parentId: "om_parent",
          threadId: "omt_1",
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("feishu:om_root");
    const mount = fx
      .calls("/im/v1/messages/om_followup/reply", "POST")
      .find((call) => call.body?.msg_type === "interactive");
    expect(mount?.body?.reply_in_thread).toBe(true);
    expect(fx.calls("/im/v1/messages/om_parent", "GET")).toHaveLength(0);
  });

  it("threaded p2p: a top-level quoted reply starts a new session but still loads its referent", async () => {
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
    const { handler, calls, idle } = buildChannel({}, "new branch");

    await handler(feishuRequest(messageEvent({ id: "om_new_root", text: "branch from this", parentId: "om_old" })));
    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("feishu:om_new_root");
    expect(fx.calls("/im/v1/messages/om_old", "GET")).toHaveLength(1);
    const mount = fx
      .calls("/im/v1/messages/om_new_root/reply", "POST")
      .find((call) => call.body?.msg_type === "interactive");
    expect(mount?.body?.reply_in_thread).toBe(true);
  });

  it("threaded p2p: roots run concurrently while turns within one root stay FIFO", async () => {
    feishuFetch();
    let releaseRootOne: () => void = () => {};
    const rootOneGate = new Promise<void>((resolve) => {
      releaseRootOne = resolve;
    });
    const starts: { session: string; ask: string }[] = [];
    injectedAgent = {
      async *invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
        const ask = prompt.text.includes("root one")
          ? "root-one"
          : prompt.text.includes("thread one")
            ? "thread-one"
            : "root-two";
        starts.push({ session: scope.session, ask });
        if (ask === "root-one") await rootOneGate;
        yield { type: "text", delta: `answer ${ask}` };
        yield { type: "completed" };
      },
    };
    const { handler, idle } = buildChannel();

    await handler(feishuRequest(messageEvent({ id: "om_root_1", text: "root one" })));
    await vi.waitFor(() => expect(starts.map((start) => start.ask)).toEqual(["root-one"]));
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_follow_1",
          text: "thread one",
          rootId: "om_root_1",
          parentId: "om_root_1",
          threadId: "omt_1",
        }),
      ),
    );
    await handler(feishuRequest(messageEvent({ id: "om_root_2", text: "root two" })));

    await vi.waitFor(() => expect(starts.map((start) => start.ask)).toEqual(["root-one", "root-two"]));
    expect(starts.map((start) => start.session)).toEqual(["feishu:om_root_1", "feishu:om_root_2"]);

    releaseRootOne();
    await idle();
    expect(starts.map((start) => start.ask)).toEqual(["root-one", "root-two", "thread-one"]);
    expect(starts[2]?.session).toBe("feishu:om_root_1");
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
    const { handler, idle } = buildChannel({ directMessageSession: "continuous" }, "pong");
    await handler(feishuRequest(messageEvent({ id: "om_retry1", text: "ping" })));
    await idle();
    expect(interactiveSends).toBe(2); // rejected once, mounted on the retry
    // Card tier survived: the SAME card settles — no text-placeholder degrade.
    expect(fx.calls("/cardkit/v1/cards/c1", "PUT")).toHaveLength(1);
    const texts = fx.calls("receive_id_type=chat_id", "POST").filter((c) => c.body?.msg_type === "text");
    expect(texts).toHaveLength(0);
  });

  it("group @mention defaults to its own root session and creates a platform thread", async () => {
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
    expect(calls[0]?.scope.session).toBe("feishu:om_g1");
    expect(calls[0]?.prompt.text).toContain("@Bot status?");
    const reply = fx.calls("/im/v1/messages/om_g1/reply", "POST")[0];
    expect(reply?.body?.msg_type).toBe("interactive");
    expect(reply?.body?.reply_in_thread).toBe(true);
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

  it("every bare user continuation in an Agent-created group thread answers through the normal streaming path", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle, home } = buildChannel();
    await flush();
    const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_managed_root",
          chatType: "group",
          content: JSON.stringify({ text: "@_user_1 start" }),
          mentions: mention,
        }),
      ),
    );
    expect(JSON.parse(readFileSync(join(home, "owned-threads.json"), "utf8"))).toHaveProperty("om_managed_root");
    await idle();

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_continuation",
          chatType: "group",
          rootId: "om_managed_root",
          parentId: "om_bot_answer",
          threadId: "omt_managed",
          text: "what about queues?",
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.scope.session)).toEqual(["feishu:om_managed_root", "feishu:om_managed_root"]);
    expect(calls[1]?.prompt.text).toContain("what about queues?");
    expect(fx.calls("/im/v1/messages/om_bot_answer", "GET")).toHaveLength(0);
    const reply = fx.calls("/im/v1/messages/om_continuation/reply", "POST")[0];
    expect(reply?.body?.msg_type).toBe("interactive");
    expect(reply?.body?.reply_in_thread).toBe(true);
    const previewCard = fx.calls("/cardkit/v1/cards", "POST")[1];
    expect(JSON.parse(String(previewCard?.body?.data)).config.streaming_mode).toBe(true);
    expect(fx.calls("/cardkit/v1/cards/c2", "PUT")).not.toHaveLength(0);
  });

  it("buffers @other-only discussion in a managed thread; a bare continuation consumes it", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    const botMention = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_targeted_root",
          chatType: "group",
          content: JSON.stringify({ text: "@_bot start" }),
          mentions: botMention,
        }),
      ),
    );
    await idle();

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_for_bob",
          chatType: "group",
          rootId: "om_targeted_root",
          threadId: "omt_targeted",
          content: JSON.stringify({ text: "@_bob please check this" }),
          mentions: [{ key: "@_bob", name: "Bob", id: { open_id: "ou_bob" } }],
        }),
      ),
    );
    await flush();
    expect(calls).toHaveLength(1);
    expect(fx.calls("/im/v1/messages/om_for_bob/reply", "POST")).toHaveLength(0);

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_bare_after_bob",
          chatType: "group",
          rootId: "om_targeted_root",
          threadId: "omt_targeted",
          text: "what is the status?",
        }),
      ),
    );
    await idle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt.text).toContain("@Bob please check this");
    expect(calls[1]?.prompt.text).toContain("what is the status?");
  });

  it("an explicit @bot still summons when the same managed-thread message also @mentions other people", async () => {
    feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    const botMention = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_multi_root",
          chatType: "group",
          content: JSON.stringify({ text: "@_bot start" }),
          mentions: botMention,
        }),
      ),
    );
    await idle();
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_multi_mention",
          chatType: "group",
          rootId: "om_multi_root",
          threadId: "omt_multi",
          content: JSON.stringify({ text: "@_bot @_bob decide together" }),
          mentions: [...botMention, { key: "@_bob", name: "Bob", id: { open_id: "ou_bob" } }],
        }),
      ),
    );
    await idle();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt.text).toContain("@Bot @Bob decide together");
  });

  it("a managed-thread continuation gets normal queue feedback while its root session is busy", async () => {
    const fx = feishuFetch();
    let releaseRoot: () => void = () => {};
    const rootGate = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    let invocation = 0;
    injectedAgent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        if (++invocation === 1) await rootGate;
        yield { type: "text", delta: invocation === 1 ? "root answer" : "continuation answer" };
        yield { type: "completed" };
      },
    };
    const { handler, idle } = buildChannel();
    await flush();
    const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];

    await handler(
      feishuRequest(
        messageEvent({ id: "om_queue_root", chatType: "group", text: "@_user_1 start", mentions: mention }),
      ),
    );
    await vi.waitFor(() => {
      expect(invocation).toBe(1);
      expect(fx.calls("/im/v1/messages/om_queue_root/reply", "POST")).not.toHaveLength(0);
    });
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_continuation_queued",
          chatType: "group",
          rootId: "om_queue_root",
          threadId: "omt_queue",
          text: "message while busy",
        }),
      ),
    );
    await flush();

    const queuedReplies = fx.calls("/im/v1/messages/om_continuation_queued/reply", "POST");
    expect(queuedReplies).toHaveLength(1);
    expect(queuedReplies[0]?.body?.reply_in_thread).toBe(true);
    const queuedCard = fx.calls("/cardkit/v1/cards", "POST")[1];
    expect(String(queuedCard?.body?.data)).toContain("Queued");

    releaseRoot();
    await idle();
    expect(invocation).toBe(2);
    expect(fx.calls("/im/v1/messages/om_continuation_queued/reply", "POST")).toHaveLength(1);
    expect(fx.calls("/cardkit/v1/cards", "POST")).toHaveLength(2); // queue card becomes the answer preview
  });

  it("a managed-thread continuation failure uses the same user-facing error path as an @mention", async () => {
    const fx = feishuFetch();
    const errors: string[] = [];
    vi.spyOn(log, "error").mockImplementation((message) => errors.push(message));
    let invocation = 0;
    injectedAgent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        if (++invocation === 1) {
          yield { type: "text", delta: "root answer" };
          yield { type: "completed" };
          return;
        }
        yield { type: "failed", details: "continuation model failed", retryable: true };
      },
    };
    const { handler, idle } = buildChannel({ onError: (failed) => `visible: ${failed.details}` });
    await flush();
    const mention = [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }];

    await handler(
      feishuRequest(
        messageEvent({ id: "om_failure_root", chatType: "group", text: "@_user_1 start", mentions: mention }),
      ),
    );
    await idle();
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_continuation_failure",
          chatType: "group",
          rootId: "om_failure_root",
          threadId: "omt_failure",
          text: "continuation failure",
        }),
      ),
    );
    await idle();

    expect(fx.calls("/im/v1/messages/om_continuation_failure/reply", "POST")).toHaveLength(1);
    const settle = fx.calls("/cardkit/v1/cards/c2", "PUT").find((call) => call.url.endsWith("/cardkit/v1/cards/c2"));
    const card = JSON.parse(String((settle?.body?.card as Record<string, unknown> | undefined)?.data));
    expect(card.body.elements[0].content).toBe("visible: continuation model failed");
    expect(errors.some((message) => message.includes("continuation model failed"))).toBe(true);
  });

  it("keeps folded context after a failed managed-thread turn and re-folds it into the retry", async () => {
    feishuFetch();
    const prompts: Prompt[] = [];
    let invocation = 0;
    injectedAgent = {
      async *invoke(_scope, prompt): AsyncIterable<AgentEvent> {
        prompts.push(prompt);
        invocation++;
        if (invocation === 2) {
          yield { type: "failed", details: "model failed", retryable: true };
          return;
        }
        yield { type: "text", delta: "ok" };
        yield { type: "completed" };
      },
    };
    const { handler, idle } = buildChannel();
    await flush();
    const botMention = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];
    const otherMention = [{ key: "@_bob", name: "Bob", id: { open_id: "ou_bob" } }];

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_failed_buffer_root",
          chatType: "group",
          content: JSON.stringify({ text: "@_bot start" }),
          mentions: botMention,
        }),
      ),
    );
    await idle();
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_failed_buffer_context",
          chatType: "group",
          rootId: "om_failed_buffer_root",
          threadId: "omt_failed_buffer",
          content: JSON.stringify({ text: "@_bob durable detail" }),
          mentions: otherMention,
        }),
      ),
    );
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_failed_buffer_ask",
          chatType: "group",
          rootId: "om_failed_buffer_root",
          threadId: "omt_failed_buffer",
          text: "first attempt",
        }),
      ),
    );
    await idle();
    expect(prompts[1]?.text).toContain("durable detail");

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_failed_buffer_retry",
          chatType: "group",
          rootId: "om_failed_buffer_root",
          threadId: "omt_failed_buffer",
          text: "retry",
        }),
      ),
    );
    await idle();
    expect(prompts[2]?.text).toContain("durable detail");
  });

  it("leaves context arriving during a managed-thread turn for the next continuation", async () => {
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
        invocation++;
        if (invocation === 2) {
          markStarted();
          await gate;
        }
        yield { type: "text", delta: "ok" };
        yield { type: "completed" };
      },
    };
    const { handler, idle } = buildChannel();
    await flush();
    const botMention = [{ key: "@_bot", name: "Bot", id: { open_id: "ou_bot" } }];
    const otherMention = [{ key: "@_bob", name: "Bob", id: { open_id: "ou_bob" } }];

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_arrival_root",
          chatType: "group",
          content: JSON.stringify({ text: "@_bot start" }),
          mentions: botMention,
        }),
      ),
    );
    await idle();
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_context_before",
          chatType: "group",
          rootId: "om_arrival_root",
          threadId: "omt_arrival",
          content: JSON.stringify({ text: "@_bob before" }),
          mentions: otherMention,
        }),
      ),
    );
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_arrival_ask",
          chatType: "group",
          rootId: "om_arrival_root",
          threadId: "omt_arrival",
          text: "run now",
        }),
      ),
    );
    await started;
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_context_during",
          chatType: "group",
          rootId: "om_arrival_root",
          threadId: "omt_arrival",
          content: JSON.stringify({ text: "@_bob during" }),
          mentions: otherMention,
        }),
      ),
    );
    release();
    await idle();

    expect(prompts[1]?.text).toContain("@Bob before");
    expect(prompts[1]?.text).not.toContain("@Bob during");
    await handler(
      feishuRequest(
        messageEvent({
          id: "om_arrival_next",
          chatType: "group",
          rootId: "om_arrival_root",
          threadId: "omt_arrival",
          text: "next",
        }),
      ),
    );
    await idle();
    expect(prompts[2]?.text).not.toContain("@Bob before");
    expect(prompts[2]?.text).toContain("@Bob during");
  });

  it("buffers an unmentioned message in a thread the Agent does not own", async () => {
    const fx = feishuFetch();
    const { handler, calls, home } = buildChannel();
    await flush();

    await handler(
      feishuRequest(
        messageEvent({
          id: "om_unowned",
          chatType: "group",
          rootId: "om_someone_elses_root",
          threadId: "omt_unowned",
          text: "ordinary discussion",
        }),
      ),
    );
    await flush();

    expect(calls).toHaveLength(0);
    expect(fx.calls("/im/v1/messages/om_unowned/reply", "POST")).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(home, "buffers.json"), "utf8"))).toHaveProperty(
      "oc_1:root:om_someone_elses_root",
    );
  });

  it("threaded group: a continuation returns to the root session without reloading its parent", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel();
    await flush();
    const evt = messageEvent({
      id: "om_group_followup",
      chatType: "group",
      rootId: "om_group_root",
      parentId: "om_group_parent",
      threadId: "omt_group",
      content: JSON.stringify({ text: "@_user_1 continue" }),
      mentions: [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }],
    });

    await handler(feishuRequest(evt));
    await idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("feishu:om_group_root");
    expect(fx.calls("/im/v1/messages/om_group_parent", "GET")).toHaveLength(0);
    const reply = fx.calls("/im/v1/messages/om_group_followup/reply", "POST")[0];
    expect(reply?.body?.reply_in_thread).toBe(true);
  });

  it("continuous group mode preserves chat/topic sessions and does not create a top-level thread", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel({ groupMessageSession: "continuous" });
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

    expect(calls.map((call) => call.scope.session)).toEqual(["oc_1", "oc_1:omt_existing"]);
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
    const { handler, idle } = buildChannel({ directMessageSession: "continuous" }, fullAnswer);

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
      const { handler, idle } = buildChannel({ directMessageSession: "continuous" });
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
    const { handler, idle } = buildChannel({ directMessageSession: "continuous" }, "plain answer");
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

  it("a custom route's null remains a full ignore and does not enter the default context buffer", async () => {
    feishuFetch();
    const { handler, calls, home } = buildChannel({ route: () => null });

    await handler(feishuRequest(messageEvent({ id: "om_custom_ignore", chatType: "group", text: "ignore me" })));
    await flush();

    expect(calls).toHaveLength(0);
    expect(existsSync(join(home, "buffers.json"))).toBe(false);
  });

  it("does not persist managed-thread ownership when a custom route owns admission", async () => {
    feishuFetch();
    const { handler, calls, home, idle } = buildChannel({ route: () => ({}) });

    await handler(feishuRequest(messageEvent({ id: "om_custom_group", chatType: "group", text: "custom" })));
    await idle();

    expect(calls).toHaveLength(1);
    expect(existsSync(join(home, "owned-threads.json"))).toBe(false);
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
          chatId: "oc_9",
          images: [],
          files: [],
          attempts: 1,
        },
      }),
    );
    const { agent, calls } = replyingAgent("recovered");
    const handler = buildFeishuChannel({ appId: "a", appSecret: "s", verificationToken: TOKEN, baseUrl: BASE })({
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
    const { handler, idle } = buildChannel({ directMessageSession: "continuous" }); // one p2p chat session
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
      directMessageSession: "continuous",
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
      baseUrl: BASE,
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
    expect(calls[0]?.scope.session).toBe("lark:om_lark1");
    const mount = fx
      .calls("/im/v1/messages/om_lark1/reply", "POST")
      .find((call) => call.body?.msg_type === "interactive");
    expect(mount?.body?.reply_in_thread).toBe(true);
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
    expect(dispatched).toEqual([{ session: "feishu:om_stop", command: { type: "abort" } }]);
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
