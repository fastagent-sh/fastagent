import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/index.ts";
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
function buildChannel(opts: Partial<FeishuChannelOptions> = {}, agentReply = "the answer") {
  const root = mkdtempSync(join(tmpdir(), "feishu-state-"));
  tempRoots.push(root);
  const { agent, calls } = replyingAgent(agentReply);
  const routes = buildFeishuChannel({
    appId: "app",
    appSecret: "secret",
    verificationToken: TOKEN,
    baseUrl: BASE,
    ...opts,
  })({ agent: opts2Agent(opts) ?? agent, stateRoot: root });
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
        ...(over.threadId ? { thread_id: over.threadId } : {}),
      },
    },
  };
}

describe("construction fails closed", () => {
  it("requires appId/appSecret/verificationToken", () => {
    expect(() => buildFeishuChannel({ appId: "", appSecret: "s", verificationToken: "t" })).toThrow(/appId/);
    expect(() => buildFeishuChannel({ appId: "a", appSecret: "s", verificationToken: "" })).toThrow(
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

  it("encrypt mode: verifies the signature over the RAW body, decrypts, and REFUSES plaintext", async () => {
    feishuFetch();
    const KEY = "enc-key";
    const { handler } = buildChannel({ encryptKey: KEY });
    const encrypt = (plain: string): string => {
      const k = createHash("sha256").update(KEY, "utf8").digest();
      const iv = randomBytes(16);
      const cipher = createCipheriv("aes-256-cbc", k, iv);
      return Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
    };
    const body = JSON.stringify({
      encrypt: encrypt(JSON.stringify({ type: "url_verification", challenge: "c9", token: TOKEN })),
    });
    const headers = (sig: string) => ({
      "x-lark-request-timestamp": "170",
      "x-lark-request-nonce": "n1",
      "x-lark-signature": sig,
    });
    const good = await handler(
      new Request("http://app/feishu", {
        method: "POST",
        body,
        headers: headers(eventSignature(KEY, "170", "n1", body)),
      }),
    );
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ challenge: "c9" });
    // Tampered signature → 401; a PLAINTEXT event while the key is set → 401 (no bypass around the signature).
    const forged = await handler(new Request("http://app/feishu", { method: "POST", body, headers: headers("bad") }));
    expect(forged.status).toBe(401);
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
  it("p2p happy path: streaming card mounted, turn runs with the envelope prompt, card settles with the answer", async () => {
    const fx = feishuFetch();
    const { handler, calls, idle } = buildChannel({}, "**bold** answer");
    expect((await handler(feishuRequest(messageEvent({ text: "hello there" })))).status).toBe(200);
    await idle();
    // The agent saw the envelope + markdown steer, on the chat-derived session.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scope.session).toBe("oc_1");
    expect(calls[0]?.prompt.text).toContain("[feishu: chat oc_1 (p2p), from user ou_alice]");
    expect(calls[0]?.prompt.text).toContain("hello there");
    expect(calls[0]?.prompt.text).toContain("standard Markdown");
    // Preview: a card entity was created (streaming mode on) and mounted as an interactive send (p2p → no reply).
    const create = fx.calls("/cardkit/v1/cards", "POST")[0];
    expect(JSON.parse(String(create?.body?.data)).config.streaming_mode).toBe(true);
    const mount = fx.calls("receive_id_type=chat_id", "POST")[0];
    expect(mount?.body?.msg_type).toBe("interactive");
    expect(JSON.parse(String(mount?.body?.content))).toEqual({ type: "card", data: { card_id: "c1" } });
    // Terminal: the SAME card settles with the final markdown, streaming off.
    const settle = fx.calls("/cardkit/v1/cards/c1", "PUT")[0];
    const settled = JSON.parse(String((settle?.body?.card as Record<string, unknown> | undefined)?.data));
    expect(settled.config.streaming_mode).toBe(false);
    expect(settled.body.elements[0].content).toBe("**bold** answer");
    // The settled card carries the answer-derived summary — the chat list / push notification shows
    // the reply, not a generic "[Card]" placeholder (markdown stripped to plain text).
    expect(settled.config.summary).toEqual({ content: "bold answer" });
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

  it("group @mention: summons via the resolved bot open_id and mounts the preview as a reply-quote", async () => {
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
    expect(calls[0]?.prompt.text).toContain("@Bot status?");
    const reply = fx.calls("/im/v1/messages/om_g1/reply", "POST")[0];
    expect(reply?.body?.msg_type).toBe("interactive");
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

  it("group without a mention is ignored (default route, fail closed)", async () => {
    feishuFetch();
    const { handler, calls } = buildChannel();
    await flush();
    expect((await handler(feishuRequest(messageEvent({ id: "om_g2", chatType: "group" }))))?.status).toBe(200);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("dedups on message_id: a duplicate push runs ONE turn, and the ring survives restarts", async () => {
    feishuFetch();
    const first = buildChannel();
    expect((await first.handler(feishuRequest(messageEvent({ id: "om_dup" })))).status).toBe(200);
    await first.idle();
    expect((await first.handler(feishuRequest(messageEvent({ id: "om_dup" })))).status).toBe(200);
    await first.idle();
    expect(first.calls).toHaveLength(1);
    // A NEW channel over the same state root (a restart) still refuses the same message_id.
    injectedAgent = undefined;
    const restarted = replyingAgent();
    const again = buildFeishuChannel({ appId: "a", appSecret: "s", verificationToken: TOKEN, baseUrl: BASE })({
      agent: restarted.agent,
      stateRoot: first.root,
    })["POST /feishu"];
    const idle2 = (again as unknown as { turnsIdle?: () => Promise<void> })?.turnsIdle;
    if (idle2) channelIdles.add(idle2);
    expect((await again?.(feishuRequest(messageEvent({ id: "om_dup" }))))?.status).toBe(200);
    await idle2?.();
    expect(restarted.calls).toHaveLength(0);
    expect(existsSync(join(first.home, "seen.json"))).toBe(true);
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

  it("queues a second ask on the SAME session behind the first and tells the asker (⏳ notice)", async () => {
    const fx = feishuFetch();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    injectedAgent = {
      async *invoke(_s: Scope, _p: Prompt): AsyncIterable<AgentEvent> {
        await gate;
        yield { type: "text", delta: "done" };
        yield { type: "completed" };
      },
    };
    const { handler } = buildChannel({ queueNoticeDelayMs: 0 }); // send the notice immediately (a long wait, compressed)
    await handler(feishuRequest(messageEvent({ id: "om_q1", text: "first" })));
    await flush(); // first turn parks on the gate with its preview mounted
    await handler(feishuRequest(messageEvent({ id: "om_q2", text: "second" })));
    // Even at delay 0 the notice leaves via a timer (one macrotask later than flush() can see) — poll.
    await vi.waitFor(() => {
      const texts = fx
        .calls("receive_id_type=chat_id", "POST")
        .map((c) =>
          c.body?.msg_type === "text" ? (JSON.parse(String(c.body?.content)) as { text: string }).text : "",
        );
      expect(texts.some((t) => t.includes("⏳ Queued"))).toBe(true);
    });
    release();
  });

  it("a FAST queue turnover never sends the ⏳ notice — no recall tombstone in the chat", async () => {
    // Lark renders a deleted message as a visible "recalled a message" line, so the notice is DELAYED:
    // a turn whose wait ends before the delay leaves no trace (default queueNoticeDelayMs ≫ this test).
    const fx = feishuFetch();
    const { handler, idle } = buildChannel();
    await handler(feishuRequest(messageEvent({ id: "om_f1", text: "first" })));
    await handler(feishuRequest(messageEvent({ id: "om_f2", text: "second" }))); // queues behind, arms the notice
    await idle(); // both turns complete well inside the notice delay
    const texts = fx
      .calls("receive_id_type=chat_id", "POST")
      .map((c) => (c.body?.msg_type === "text" ? (JSON.parse(String(c.body?.content)) as { text: string }).text : ""));
    expect(texts.some((t) => t.includes("⏳ Queued"))).toBe(false); // never sent …
    expect(fx.calls("/im/v1/messages/", "DELETE")).toHaveLength(0); // … so nothing was recalled
  });
});

describe("the Lark compatibility profile", () => {
  it("reuses the Feishu engine with its own route, state, envelope, and log brand", async () => {
    feishuFetch();
    const info: string[] = [];
    vi.spyOn(log, "info").mockImplementation((message) => info.push(message));
    const root = mkdtempSync(join(tmpdir(), "lark-state-"));
    tempRoots.push(root);
    const { agent, calls } = replyingAgent("pong");
    const routes = larkChannel({ appId: "app", appSecret: "secret", verificationToken: TOKEN, baseUrl: BASE })({
      agent,
      stateRoot: root,
    });
    expect(routes["POST /feishu"]).toBeUndefined();
    const handler = routes["POST /lark"];
    if (!handler) throw new Error("expected POST /lark");
    const maybeIdle = (handler as { turnsIdle?: () => Promise<void> }).turnsIdle;
    if (maybeIdle) channelIdles.add(maybeIdle);
    const res = await handler(feishuRequest(messageEvent({ id: "om_lark1", text: "ping" })));
    expect(res.status).toBe(200);
    await maybeIdle?.();
    expect(calls[0]?.prompt.text).toContain("[lark: chat oc_1 (p2p)");
    expect(info.some((line) => line.startsWith("[lark] turn start:"))).toBe(true);
    expect(existsSync(join(root, "channels", "lark"))).toBe(true);
    expect(existsSync(join(root, "channels", "feishu"))).toBe(false);
  });

  it("construction failures name each public factory", () => {
    expect(() => buildFeishuChannel({ appId: "", appSecret: "s", verificationToken: "t" })).toThrow(/feishuChannel/);
    expect(() => larkChannel({ appId: "", appSecret: "s", verificationToken: "t" })).toThrow(/larkChannel/);
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
