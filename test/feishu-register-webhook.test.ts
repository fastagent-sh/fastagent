import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFeishuWebhook } from "../src/channels/feishu/register-webhook.ts";

// Mirrors the telegram registrar's G5 discipline: the application-v7 config PATCH triggers the
// platform's url_verification challenge against the new Request URL, so registration must wait until
// the server actually serves — and a permanent config error degrades to the manual console path.
// The registrar serves BOTH kinds (feishu/lark): the kind picks the env namespace, API base, and path.
describe("registerFeishuWebhook: waits for /health, then PATCHes the event subscription", () => {
  const prev = {
    id: process.env.LARK_APP_ID,
    secret: process.env.LARK_APP_SECRET,
    fid: process.env.FEISHU_APP_ID,
    fsecret: process.env.FEISHU_APP_SECRET,
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.LARK_APP_ID = prev.id;
    process.env.LARK_APP_SECRET = prev.secret;
    process.env.FEISHU_APP_ID = prev.fid;
    process.env.FEISHU_APP_SECRET = prev.fsecret;
  });

  function creds(prefix: "LARK" | "FEISHU" = "FEISHU") {
    process.env[`${prefix}_APP_ID`] = "cli_app";
    process.env[`${prefix}_APP_SECRET`] = "sec";
  }

  it("polls /health until reachable, THEN PATCHes webhook mode + the request URL exactly once", async () => {
    creds();
    let health = 0;
    const patches: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url.endsWith("/health")) {
          health++;
          return new Response(null, { status: health < 3 ? 503 : 200 }); // not ready until the 3rd poll
        }
        if (url.includes("tenant_access_token")) {
          return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
        }
        if (url.includes("/application/v7/applications/")) {
          patches.push({ url, body: JSON.parse(String(init.body)) });
          return Response.json({ code: 0, msg: "ok", data: {} });
        }
        return new Response(null, { status: 404 });
      }),
    );
    await registerFeishuWebhook("https://x.trycloudflare.com", "feishu", {
      readyTimeoutMs: 5000,
      readyIntervalMs: 1,
      apiBase: "http://feishu.test",
    });
    expect(health).toBeGreaterThanOrEqual(3); // waited for readiness, not a fixed timer
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain("http://feishu.test/open-apis/application/v7/applications/cli_app/config");
    expect(patches[0]?.body).toEqual({
      event: { subscription_type: "webhook", request_url: "https://x.trycloudflare.com/feishu" },
    });
  });

  it("the Lark compatibility profile reads LARK_* credentials and registers <baseUrl>/lark", async () => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    creds("LARK");
    const patches: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url.endsWith("/health")) return new Response(null, { status: 200 });
        if (url.includes("tenant_access_token")) {
          return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
        }
        if (url.includes("/application/v7/applications/")) {
          patches.push({ url, body: JSON.parse(String(init.body)) });
          return Response.json({ code: 0, msg: "ok", data: {} });
        }
        return new Response(null, { status: 404 });
      }),
    );
    await registerFeishuWebhook("https://x.trycloudflare.com", "lark", {
      readyTimeoutMs: 100,
      readyIntervalMs: 1,
      apiBase: "http://larksuite.test",
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain("http://larksuite.test/open-apis/application/v7/applications/cli_app/config");
    expect(patches[0]?.body).toEqual({
      event: { subscription_type: "webhook", request_url: "https://x.trycloudflare.com/lark" },
    });
  });

  it("never PATCHes against a URL that isn't up — gives up with the manual instruction", async () => {
    creds();
    const patches: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/application/v7/")) {
          patches.push(url);
          return Response.json({ code: 0, msg: "ok", data: {} });
        }
        throw new Error("ECONNREFUSED"); // /health never reachable
      }),
    );
    await registerFeishuWebhook("https://dead.example", "feishu", { readyTimeoutMs: 20, readyIntervalMs: 5 });
    expect(patches).toHaveLength(0);
  });

  it("210042 request_url validation (the platform's path to a fresh edge lagging) is retried until it lands", async () => {
    creds();
    let patches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) return new Response(null, { status: 200 });
        if (url.includes("tenant_access_token")) {
          return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
        }
        if (url.includes("/application/v7/")) {
          // The first two challenges fail (edge not yet routable from the platform), then it heals.
          return ++patches < 3
            ? Response.json({ code: 210042, msg: "The validation for event.request_url failed." })
            : Response.json({ code: 0, msg: "ok", data: {} });
        }
        return new Response(null, { status: 404 });
      }),
    );
    await registerFeishuWebhook("https://x.trycloudflare.com", "feishu", {
      readyTimeoutMs: 100,
      readyIntervalMs: 1,
      retryMs: 1,
      apiBase: "http://feishu.test",
    });
    expect(patches).toBe(3); // failed twice, registered on the third
  });

  it("a PERMANENT config reject (missing scope) is reported once with the manual path, not retried", async () => {
    creds();
    let patches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) return new Response(null, { status: 200 });
        if (url.includes("tenant_access_token")) {
          return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
        }
        if (url.includes("/application/v7/")) {
          patches++;
          return Response.json({ code: 210037, msg: "no permission to modify the app configurations" });
        }
        return new Response(null, { status: 404 });
      }),
    );
    await registerFeishuWebhook("https://x.trycloudflare.com", "feishu", {
      readyTimeoutMs: 100,
      readyIntervalMs: 1,
      retryMs: 1,
      apiBase: "http://feishu.test",
    });
    expect(patches).toBe(1); // permanent error — no blind retries
  });

  it("the Lark compatibility profile falls back on its missing config route", async () => {
    creds("LARK");
    let patches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) return new Response(null, { status: 200 });
        if (url.includes("tenant_access_token")) {
          return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
        }
        if (url.includes("/application/v7/")) {
          patches++;
          return new Response("404 page not found", { status: 404, headers: { "content-type": "text/plain" } });
        }
        return new Response(null, { status: 404 });
      }),
    );
    const warned: string[] = [];
    const { log } = await import("../src/log.ts");
    const spy = vi.spyOn(log, "warn").mockImplementation((m: string) => {
      warned.push(m);
    });
    const onManualRegistration = vi.fn();
    await registerFeishuWebhook("https://x.trycloudflare.com", "lark", {
      readyTimeoutMs: 100,
      readyIntervalMs: 1,
      retryMs: 1,
      apiBase: "http://larksuite.test", // the intl cloud — no v7 config route
      onManualRegistration,
    });
    spy.mockRestore();
    expect(patches).toBe(1); // a missing route never gets blind retries
    expect(warned.join("\n")).toMatch(/profile: probe-with-manual-fallback/);
    expect(onManualRegistration).toHaveBeenCalledOnce();
    expect(onManualRegistration).toHaveBeenCalledWith({
      consoleUrl: "http://larksuite.test/app/cli_app/event",
      requestUrl: "https://x.trycloudflare.com/lark",
    });
  });

  it("missing credentials print the instruction and touch nothing", async () => {
    delete process.env.LARK_APP_ID;
    delete process.env.LARK_APP_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await registerFeishuWebhook("https://x.trycloudflare.com", "lark");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
