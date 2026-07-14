import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTelegramWebhook } from "../src/channels/telegram/register-webhook.ts";

// G5: the webhook must be registered only AFTER the server is reachable — Telegram verifies the URL when
// you set it, and a fresh deploy's container (or tunnel DNS) isn't routable for some seconds after the
// deploy command returns. These pin "poll /health, then register", the fix for the deploy-race that made
// the first real deploy need a manual setWebhook.
describe("registerTelegramWebhook: waits for /health before setWebhook", () => {
  const prevBot = process.env.TELEGRAM_BOT_TOKEN;
  const prevSecret = process.env.TELEGRAM_SECRET_TOKEN;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = prevBot;
    process.env.TELEGRAM_SECRET_TOKEN = prevSecret;
  });

  it("polls /health until reachable, THEN registers exactly once", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bt";
    process.env.TELEGRAM_SECRET_TOKEN = "st";
    let health = 0;
    const setWebhook: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) {
          health++;
          return new Response(null, { status: health < 3 ? 503 : 200 }); // not ready until the 3rd poll
        }
        if (url.includes("/setWebhook")) {
          setWebhook.push(url);
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }),
    );
    await registerTelegramWebhook("https://app.up.railway.app", { readyTimeoutMs: 5000, readyIntervalMs: 1 });
    expect(health).toBeGreaterThanOrEqual(3); // waited for readiness, not a fixed timer
    expect(setWebhook).toHaveLength(1); // registered once, AFTER /health returned 200
  });

  it("never setWebhooks against a URL that isn't up — gives up with a manual instruction", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bt";
    process.env.TELEGRAM_SECRET_TOKEN = "st";
    const setWebhook: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/setWebhook")) {
          setWebhook.push(url);
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        throw new Error("ECONNREFUSED"); // /health never reachable
      }),
    );
    await registerTelegramWebhook("https://dead.up.railway.app", { readyTimeoutMs: 20, readyIntervalMs: 5 });
    expect(setWebhook).toHaveLength(0); // no registration against a URL Telegram couldn't reach either
  });

  it("after /health is up, retries a TRANSIENT setWebhook failure and succeeds", async () => {
    // Telegram's resolver can lag /health by a moment — the first setWebhook may hit "resolve host".
    process.env.TELEGRAM_BOT_TOKEN = "bt";
    process.env.TELEGRAM_SECRET_TOKEN = "st";
    let setWebhookCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) return new Response(null, { status: 200 });
        if (url.includes("/setWebhook")) {
          setWebhookCalls++;
          if (setWebhookCalls === 1) throw new Error("getaddrinfo ENOTFOUND api.telegram.org"); // transient
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }),
    );
    await registerTelegramWebhook("https://app.up.railway.app", { readyTimeoutMs: 5000, readyIntervalMs: 1 });
    expect(setWebhookCalls).toBe(2); // retried the transient failure, then succeeded
  });

  it("does NOT retry a PERMANENT setWebhook error (a config problem, not a race)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bt";
    process.env.TELEGRAM_SECRET_TOKEN = "st";
    let setWebhookCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) return new Response(null, { status: 200 });
        if (url.includes("/setWebhook")) {
          setWebhookCalls++;
          // A permanent Bad Request (e.g. HTTPS url required) — ok:false, not a network error.
          return new Response(JSON.stringify({ ok: false, description: "Bad Request: bad webhook" }), { status: 400 });
        }
        return new Response(null, { status: 404 });
      }),
    );
    await registerTelegramWebhook("https://app.up.railway.app", { readyTimeoutMs: 5000, readyIntervalMs: 1 });
    expect(setWebhookCalls).toBe(1); // reported, not retried
  });

  it("reports the last transient error after exhausting setWebhook retries", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bt";
    process.env.TELEGRAM_SECRET_TOKEN = "st";
    let setWebhookCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) return new Response(null, { status: 200 });
        setWebhookCalls++;
        throw new Error(`fetch failed attempt ${setWebhookCalls}`);
      }),
    );
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await registerTelegramWebhook("https://app.up.railway.app", {
      readyTimeoutMs: 5000,
      readyIntervalMs: 1,
      retryMs: 1,
    });

    expect(setWebhookCalls).toBe(3);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/last error: .*fetch failed attempt 3/));
  });

  it("missing tokens → manual instruction, no health poll and no setWebhook", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_SECRET_TOKEN;
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await registerTelegramWebhook("https://x.up.railway.app");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
