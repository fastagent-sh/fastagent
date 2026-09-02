import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTelegramWebhook } from "../src/channels/telegram/register-webhook.ts";
import { log } from "../src/log.ts";

// G5: the webhook must end up registered even though a fresh deploy's container (or a fresh tunnel's
// edge) is not routable for some seconds. setWebhook itself is the probe — Telegram VERIFIES the URL
// during the call, from Telegram's network — so its "could not reach it" verdicts are retried while a
// configuration error is reported once. No local /health poll precedes it: this machine's reach is a
// different question, and a freshly minted hostname is routinely unreachable from here (#421).
describe("registerTelegramWebhook: setWebhook is its own readiness probe", () => {
  const prevBot = process.env.TELEGRAM_BOT_TOKEN;
  const prevSecret = process.env.TELEGRAM_SECRET_TOKEN;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = prevBot;
    process.env.TELEGRAM_SECRET_TOKEN = prevSecret;
  });

  it("registers exactly once, without probing the URL from this machine", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bt";
    process.env.TELEGRAM_SECRET_TOKEN = "st";
    const called: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        called.push(url);
        if (url.includes("/setWebhook")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }),
    );
    const ok = await registerTelegramWebhook("https://app.up.railway.app");
    expect(ok).toBe("registered");
    expect(called).toHaveLength(1);
    expect(called[0]).toContain("/setWebhook");
    // The fresh hostname is never dialled from here — only Telegram has to reach it.
    expect(called.some((url) => new URL(url).hostname === "app.up.railway.app")).toBe(false);
  });

  it("retries while TELEGRAM cannot reach the URL yet, then succeeds", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bt";
    process.env.TELEGRAM_SECRET_TOKEN = "st";
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        // 1: the tunnel edge answers 530 with no origin; 2: Telegram's resolver still lags.
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              ok: false,
              description: "Bad Request: bad webhook: Wrong response from the webhook: 530 Origin DNS error",
            }),
            { status: 400 },
          );
        }
        if (calls === 2) throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }),
    );
    const ok = await registerTelegramWebhook("https://x.trycloudflare.com", { retryMs: 1 });
    expect(ok).toBe("registered");
    expect(calls).toBe(3);
  });

  it("does NOT retry a PERMANENT setWebhook error (a config problem, not a race)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bt";
    process.env.TELEGRAM_SECRET_TOKEN = "st";
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response(
          JSON.stringify({
            ok: false,
            description: "Bad Request: bad webhook: HTTPS url must be provided for webhook",
          }),
          { status: 400 },
        );
      }),
    );
    const ok = await registerTelegramWebhook("http://app.up.railway.app", { retryMs: 1 });
    expect(ok).toBe("failed"); // a config error the operator must fix → deploy --run gates
    expect(calls).toBe(1); // reported, not retried
  });

  it("reports the last unreachable-URL error after exhausting retries", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bt";
    process.env.TELEGRAM_SECRET_TOKEN = "st";
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        throw new Error(`fetch failed attempt ${calls}`);
      }),
    );
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await registerTelegramWebhook("https://app.up.railway.app", { attempts: 3, retryMs: 1 });

    expect(calls).toBe(3);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/last error: .*fetch failed attempt 3/));
  });

  it("terminal failures log at ERROR (webhook not registered → operator must act)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bt";
    process.env.TELEGRAM_SECRET_TOKEN = "st";
    const errors: string[] = [];
    vi.spyOn(log, "error").mockImplementation((m: string) => {
      errors.push(m);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );

    const exhausted = await registerTelegramWebhook("https://app.up.railway.app", { attempts: 2, retryMs: 1 });
    expect(exhausted).toBe("failed");
    expect(errors.join("\n")).toMatch(/could not reach .*after retries.*register manually/is);
  });

  it("missing tokens → manual instruction, no API call at all", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_SECRET_TOKEN;
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const ok = await registerTelegramWebhook("https://x.up.railway.app");
    expect(ok).toBe("manual"); // not configured is the designed manual path, not a deploy gate
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
