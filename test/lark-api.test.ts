import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkLarkText, createLarkApi } from "../src/channels/lark/lark-api.ts";

const BASE = "http://lark.test";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A dispatching fetch fake: tenant-token calls answer with a token; everything else hits `route`. */
function stubFetch(route: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: () => { url: string; init: RequestInit }[];
  tokenFetches: () => number;
} {
  const seen: { url: string; init: RequestInit }[] = [];
  let tokens = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      seen.push({ url: String(url), init });
      if (String(url).includes("/auth/v3/tenant_access_token/internal")) {
        tokens++;
        return Response.json({ code: 0, msg: "ok", tenant_access_token: `T${tokens}`, expire: 7200 });
      }
      return route(String(url), init);
    }),
  );
  return { calls: () => seen, tokenFetches: () => tokens };
}

const okData = (data: unknown = {}) => Response.json({ code: 0, msg: "success", data });

describe("tenant token cache", () => {
  it("fetches the token once and reuses it across calls (Authorization carries it)", async () => {
    const fx = stubFetch(() => okData({ message_id: "om_1" }));
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    await api.sendMessage("oc_1", "text", '{"text":"x"}');
    await api.sendMessage("oc_1", "text", '{"text":"y"}');
    expect(fx.tokenFetches()).toBe(1);
    const apiCalls = fx.calls().filter((c) => c.url.includes("/im/v1/messages"));
    expect(apiCalls).toHaveLength(2);
    for (const c of apiCalls) {
      expect((c.init.headers as Record<string, string>).authorization).toBe("Bearer T1");
    }
  });

  it("invalidates + refetches ONCE when the platform rejects the token, then retries the call", async () => {
    let rejected = false;
    const fx = stubFetch(() => {
      if (!rejected) {
        rejected = true;
        return Response.json({ code: 99991663, msg: "token expired" });
      }
      return okData({ message_id: "om_2" });
    });
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    expect(await api.sendMessage("oc_1", "text", "{}")).toBe("om_2");
    expect(fx.tokenFetches()).toBe(2); // initial + the one refetch
    const last = fx.calls().at(-1);
    expect((last?.init.headers as Record<string, string>).authorization).toBe("Bearer T2");
  });

  it("a PERSISTENT auth reject fails after one refetch (no infinite refresh loop)", async () => {
    stubFetch(() => Response.json({ code: 99991663, msg: "token expired" }));
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    await expect(api.sendMessage("oc_1", "text", "{}")).rejects.toThrow(/99991663|token expired/);
  });
});

describe("pipeline invariants", () => {
  it("success requires the body's own code===0 — an HTTP 200 with an error code is a named failure", async () => {
    stubFetch(() => Response.json({ code: 230002, msg: "the bot can not be outside the group" }));
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    await expect(api.sendMessage("oc_1", "text", "{}")).rejects.toThrow(/sendMessage.*230002.*bot can not be outside/);
  });

  it("carries a 30s timeout signal on every JSON call (a wedged connection can't hang the turn)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubFetch(() => okData({}));
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    await api.editTextMessage("om_1", "hi");
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("retries a rate-limit reject with a wait, bounded — then fails visibly", async () => {
    vi.useFakeTimers();
    let calls = 0;
    stubFetch(() => {
      calls++;
      return new Response(JSON.stringify({ code: 99991400, msg: "frequency limit" }), { status: 429 });
    });
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    const p = api.sendMessage("oc_1", "text", "{}").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1); // waiting, not hammering
    await vi.advanceTimersByTimeAsync(20_000);
    const err = await p;
    expect(String(err)).toMatch(/gave up after 3 retries/);
    expect(calls).toBe(4); // 1 + 3 bounded retries
  });

  it("a non-JSON body degrades to a named failure, never a silent success", async () => {
    stubFetch(() => new Response("<html>gateway error</html>", { status: 502 }));
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    await expect(api.deleteMessage("om_1")).rejects.toThrow(/deleteMessage failed: 502/);
  });
});

describe("message methods", () => {
  it("sendText quote-replies the FIRST chunk (in-thread when asked) and plain-sends the rest", async () => {
    const bodies: { url: string; body: Record<string, unknown> }[] = [];
    stubFetch((url, init) => {
      bodies.push({ url, body: JSON.parse(String(init.body)) });
      return okData({ message_id: `om_${bodies.length}` });
    });
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    // Two chunks: force the split with a text over the cap (multi-byte safe splitting is covered below).
    const long = `${"a".repeat(90 * 1024)}\n${"b".repeat(60 * 1024)}`;
    const firstId = await api.sendText({ chatId: "oc_1", replyTo: "om_ask", replyInThread: true }, long);
    expect(firstId).toBe("om_1");
    expect(bodies[0]?.url).toContain("/im/v1/messages/om_ask/reply");
    expect(bodies[0]?.body.reply_in_thread).toBe(true);
    expect(bodies[1]?.url).toContain("/im/v1/messages?receive_id_type=chat_id");
    expect(bodies[1]?.body.receive_id).toBe("oc_1");
    const sentText = bodies.map((b) => (JSON.parse(b.body.content as string) as { text: string }).text);
    expect(sentText.join("\n")).toBe(long); // lossless across the split
  });

  it("editTextMessage PUTs the platform's text envelope at the message", async () => {
    const reqs: { url: string; init: RequestInit }[] = [];
    stubFetch((url, init) => {
      reqs.push({ url, init });
      return okData({});
    });
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    await api.editTextMessage("om_9", "final");
    expect(reqs[0]?.url).toContain("/im/v1/messages/om_9");
    expect(reqs[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(reqs[0]?.init.body))).toEqual({ msg_type: "text", content: '{"text":"final"}' });
  });
});

describe("card methods", () => {
  it("createCard posts card_json and returns the card_id; a missing id is a named failure", async () => {
    let give = true;
    const reqs: Record<string, unknown>[] = [];
    stubFetch((_url, init) => {
      reqs.push(JSON.parse(String(init.body)));
      return okData(give ? { card_id: "c1" } : {});
    });
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    expect(await api.createCard('{"schema":"2.0"}')).toBe("c1");
    expect(reqs[0]).toEqual({ type: "card_json", data: '{"schema":"2.0"}' });
    give = false;
    await expect(api.createCard("{}")).rejects.toThrow(/no card_id/);
  });

  it("updateCardElement PUTs the full-text snapshot + sequence at the element", async () => {
    const reqs: { url: string; body: Record<string, unknown> }[] = [];
    stubFetch((url, init) => {
      reqs.push({ url, body: JSON.parse(String(init.body)) });
      return okData({});
    });
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    await api.updateCardElement("c1", "answer", "partial…", 7);
    expect(reqs[0]?.url).toContain("/cardkit/v1/cards/c1/elements/answer/content");
    expect(reqs[0]?.body).toEqual({ content: "partial…", sequence: 7 });
  });
});

describe("app config (scan-to-create + webhook registration)", () => {
  it("getAppConfig reads the platform-generated event-security material from the v6 app detail", async () => {
    const fx = stubFetch(() =>
      Response.json({
        code: 0,
        msg: "ok",
        data: { app: { app_id: "cli_a", encryption: { verification_token: "vt-1", encryption_key: "ek-1" } } },
      }),
    );
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    expect(await api.getAppConfig("cli_a")).toEqual({ verificationToken: "vt-1", encryptionKey: "ek-1" });
    expect(fx.calls().at(-1)?.url).toContain("/open-apis/application/v6/applications/cli_a?lang=zh_cn");
  });

  it("updateEventSubscription PATCHes webhook mode + the request URL at the v7 config", async () => {
    const reqs: { url: string; method?: string; body: Record<string, unknown> }[] = [];
    stubFetch((url, init) => {
      reqs.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      return okData({});
    });
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    await api.updateEventSubscription("cli_a", { subscriptionType: "webhook", requestUrl: "https://x.dev/lark" });
    expect(reqs[0]?.url).toContain("/open-apis/application/v7/applications/cli_a/config");
    expect(reqs[0]?.method).toBe("PATCH");
    expect(reqs[0]?.body).toEqual({ event: { subscription_type: "webhook", request_url: "https://x.dev/lark" } });
  });
});

describe("resources", () => {
  it("fetchImage downloads the message resource and mimes from the content-type (fallback jpeg)", async () => {
    stubFetch(
      (url) =>
        new Response(Buffer.from("png-bytes"), {
          status: 200,
          headers: { "content-type": url.includes("img_png") ? "image/png" : "application/octet-stream" },
        }),
    );
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    const png = await api.fetchImage("om_1", "img_png");
    expect(png.mimeType).toBe("image/png");
    expect(Buffer.from(png.data, "base64").toString()).toBe("png-bytes");
    const other = await api.fetchImage("om_1", "img_odd");
    expect(other.mimeType).toBe("image/jpeg"); // non-image content type → safe default
  });

  it("a failed download is a named error carrying the platform's own message", async () => {
    stubFetch(() => new Response(JSON.stringify({ code: 234001, msg: "resource expired" }), { status: 400 }));
    const api = createLarkApi({ baseUrl: BASE, appId: "a", appSecret: "s" });
    await expect(api.fetchImage("om_1", "k")).rejects.toThrow(/downloadResource.*resource expired/);
  });
});

describe("chunkLarkText", () => {
  it("splits at a newline under the BYTE cap (multi-byte safe) and reconstructs losslessly", () => {
    expect(chunkLarkText("short")).toEqual(["short"]);
    const cjk = `${"好".repeat(10)}\n${"多".repeat(10)}`; // 3 bytes per char
    const chunks = chunkLarkText(cjk, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(40);
    expect(chunks.join("\n")).toBe(cjk); // the split point was the newline
  });

  it("hard-cuts a single overlong line without splitting a multi-byte character", () => {
    const chunks = chunkLarkText("好".repeat(30), 32); // no newline anywhere
    for (const c of chunks) {
      expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(32);
      expect(c).toMatch(/^好+$/); // no torn surrogate/partial char
    }
    expect(chunks.join("")).toBe("好".repeat(30));
  });
});
