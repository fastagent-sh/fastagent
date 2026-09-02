import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFeishuWebhook } from "../src/channels/feishu/register-webhook.ts";
import { log } from "../src/log.ts";

// Mirrors the telegram registrar's G5 discipline: the application-v7 config PATCH triggers the
// platform's url_verification challenge against the new Request URL, so the PATCH is itself the
// readiness probe — retried while the platform cannot verify the URL, and degrading to the manual
// console path on a permanent config error. Nothing polls the URL from this machine (#421).
// The registrar serves BOTH kinds (feishu/lark): the kind picks the env namespace, API base, and path.
describe("registerFeishuWebhook: the config PATCH is its own readiness probe", () => {
  const prev = {
    id: process.env.LARK_APP_ID,
    secret: process.env.LARK_APP_SECRET,
    fid: process.env.FEISHU_APP_ID,
    fsecret: process.env.FEISHU_APP_SECRET,
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env.LARK_APP_ID = prev.id;
    process.env.LARK_APP_SECRET = prev.secret;
    process.env.FEISHU_APP_ID = prev.fid;
    process.env.FEISHU_APP_SECRET = prev.fsecret;
  });

  function creds(prefix: "LARK" | "FEISHU" = "FEISHU") {
    process.env[`${prefix}_APP_ID`] = "cli_app";
    process.env[`${prefix}_APP_SECRET`] = "sec";
  }

  it("PATCHes webhook mode + the request URL exactly once, without probing the URL from here", async () => {
    creds();
    const dialled: string[] = [];
    const patches: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        dialled.push(url);
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
    const ok = await registerFeishuWebhook("https://x.trycloudflare.com", "feishu", {
      apiBase: "http://feishu.test",
    });
    expect(ok).toBe("registered");
    // Only the platform is asked — the fresh tunnel hostname is never dialled from here.
    expect(dialled.some((url) => new URL(url).hostname.endsWith("trycloudflare.com"))).toBe(false);
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
      apiBase: "http://larksuite.test",
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain("http://larksuite.test/open-apis/application/v7/applications/cli_app/config");
    expect(patches[0]?.body).toEqual({
      event: { subscription_type: "webhook", request_url: "https://x.trycloudflare.com/lark" },
    });
  });

  it("210042 request_url validation (the platform's path to a fresh edge lagging) is retried until it lands", async () => {
    creds();
    let patches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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
      retryMs: 1,
      apiBase: "http://feishu.test",
    });
    expect(patches).toBe(3); // failed twice, registered on the third
  });

  it("opens the exact App after request-URL validation exhausts its bounded retries", async () => {
    creds();
    let patches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("tenant_access_token")) {
          return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
        }
        if (url.includes("/application/v7/")) {
          patches++;
          return Response.json({ code: 210042, msg: "The validation for event.request_url failed." });
        }
        return new Response(null, { status: 404 });
      }),
    );
    const errors: string[] = [];
    vi.spyOn(log, "error").mockImplementation((m: string) => {
      errors.push(m);
    });
    const onManualRegistration = vi.fn();
    const ok = await registerFeishuWebhook("https://x.trycloudflare.com", "feishu", {
      retryMs: 1,
      apiBase: "http://feishu.test",
      onManualRegistration,
    });
    expect(ok).toBe("failed"); // terminal for this run → deploy --run gates
    expect(patches).toBe(8);
    // Exhausted retries are a terminal failure (event URL not registered) — reported at ERROR.
    expect(errors.join("\n")).toMatch(/could not verify .*after retries/);
    expect(onManualRegistration).toHaveBeenCalledOnce();
    expect(onManualRegistration).toHaveBeenCalledWith({
      consoleUrl: "http://feishu.test/app/cli_app/event",
      requestUrl: "https://x.trycloudflare.com/feishu",
    });
  });

  it("a PERMANENT config reject (missing scope) is reported once with the manual path, not retried", async () => {
    creds();
    let patches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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
    const ok = await registerFeishuWebhook("https://x.trycloudflare.com", "feishu", {
      retryMs: 1,
      apiBase: "http://feishu.test",
    });
    expect(ok).toBe("failed"); // a config error the operator must fix → deploy --run gates
    expect(patches).toBe(1); // permanent error — no blind retries
  });

  it("the Lark compatibility profile falls back on its missing config route", async () => {
    creds("LARK");
    let patches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
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
    const informed: string[] = [];
    const { log } = await import("../src/log.ts");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation((m: string) => {
      warned.push(m);
    });
    const infoSpy = vi.spyOn(log, "info").mockImplementation((m: string) => {
      informed.push(m);
    });
    const onManualRegistration = vi.fn();
    const ok = await registerFeishuWebhook("https://x.trycloudflare.com", "lark", {
      retryMs: 1,
      apiBase: "http://larksuite.test", // the intl cloud — no v7 config route
      onManualRegistration,
    });
    expect(ok).toBe("manual"); // the norm on this cloud — a re-run can never succeed, so no re-run gate
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    expect(patches).toBe(1); // a missing route never gets blind retries
    expect(warned.join("\n")).toMatch(/HTTP 404.*manual registration/);
    expect(informed.join("\n")).toMatch(
      /webhook mode has not been published yet.*create \+ publish a version.*http:\/\/larksuite\.test\/app\/cli_app\/version/s,
    );
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
    const ok = await registerFeishuWebhook("https://x.trycloudflare.com", "lark");
    expect(ok).toBe("manual"); // not configured is the designed manual path, not a deploy gate
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
