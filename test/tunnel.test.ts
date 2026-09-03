import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSlackOnboardingState } from "../src/channels/slack/onboard.ts";
import { writeSlackOnboardingState } from "../src/channels/slack/onboarding-state.ts";
import { declaredChannels } from "../src/channels/discover.ts";
import { REGISTRATION_RETRY_MS } from "../src/channels/registration.ts";
import {
  TUNNEL_DNS_LAG_MS,
  announceWebhooks,
  hasTunnelConnection,
  parseTunnelUrl,
  startCloudflareTunnel,
} from "../src/tunnel.ts";

// Mirrors TUNNEL_RETRY_MS in tunnel.ts (the constant is not exported).
const TUNNEL_RETRY_MS = 2000;

/** A fake cloudflared child: EventEmitter with stdout/stderr emitters, drivable from a test. */
function fakeCloudflared(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  return child as unknown as ChildProcess;
}

/** Collect console.error lines for assertions. */
function captureErrors(): string[] {
  const errs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((m) => {
    errs.push(String(m));
  });
  return errs;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_SECRET_TOKEN;
  delete process.env.LARK_APP_ID;
  delete process.env.LARK_APP_SECRET;
});

/** A fetch stub: /health always serves 200; setWebhook returns each queued response in turn. */
function webhookFetch(setWebhookResponses: { status: number; body: string }[]) {
  let i = 0;
  return vi.fn(async (url: string) => {
    if (String(url).includes("setWebhook")) {
      const r = setWebhookResponses[Math.min(i++, setWebhookResponses.length - 1)];
      return new Response(r?.body ?? '{"ok":true}', { status: r?.status ?? 200 });
    }
    return new Response("ok", { status: 200 }); // /health → tunnel is serving
  });
}

async function workspace(channels: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-tunnel-"));
  await mkdir(join(dir, "channels"), { recursive: true });
  for (const c of channels) await writeFile(join(dir, "channels", `${c}.ts`), "export default () => ({});\n");
  return dir;
}

describe("tunnel: startCloudflareTunnel", () => {
  // #435: the URL is printed while the hostname is still NXDOMAIN, and a platform told about it in
  // that window keeps answering "cannot resolve" long past any registrar's retry budget. The record
  // follows the edge connection, so that line — not the URL — is when the tunnel can be handed over.
  it("resolves a tunnel once the URL is assigned AND the edge connection is up", async () => {
    vi.useFakeTimers();
    const child = fakeCloudflared();
    let handedOut: string | undefined;
    const p = startCloudflareTunnel(8800, () => child).then((t) => {
      handedOut = t?.url;
      return t;
    });
    await Promise.resolve(); // let the listeners attach
    child.stderr?.emit("data", Buffer.from("INF +-+ https://blue-cat-42.trycloudflare.com +-+\n"));

    await vi.advanceTimersByTimeAsync(TUNNEL_DNS_LAG_MS * 2);
    expect(handedOut, "a URL whose tunnel has not connected must not reach a registrar").toBeUndefined();

    child.stderr?.emit("data", Buffer.from("INF Registered tunnel connection connIndex=0 ip=198.41.200.63\n"));
    await vi.advanceTimersByTimeAsync(TUNNEL_DNS_LAG_MS);
    expect((await p)?.url).toBe("https://blue-cat-42.trycloudflare.com");
  });

  // Retrying would meet the same network with a new hostname, so the URL is served and the cause
  // named. Silence here would send the author to debug the platform for a local tunnel failure.
  it("serves a URL whose tunnel never connected, naming that as the fault", async () => {
    vi.useFakeTimers();
    const errs = captureErrors();
    const child = fakeCloudflared();
    const p = startCloudflareTunnel(8800, () => child, 100);
    await Promise.resolve();
    child.stderr?.emit("data", Buffer.from("INF |  https://blue-cat-42.trycloudflare.com  |\n"));
    await vi.advanceTimersByTimeAsync(100);
    expect((await p)?.url).toBe("https://blue-cat-42.trycloudflare.com");
    expect(errs.some((e) => /never reported an edge connection/.test(e))).toBe(true);
    expect(child.kill, "the tunnel is served, not killed").not.toHaveBeenCalled();
  });

  it("does not retry a missing cloudflared (ENOENT); logs the install hint", async () => {
    const errs = captureErrors();
    let spawns = 0;
    const child = fakeCloudflared();
    const p = startCloudflareTunnel(8800, () => {
      spawns++;
      return child;
    });
    await Promise.resolve();
    child.emit("error", Object.assign(new Error("spawn cloudflared"), { code: "ENOENT" }));
    expect(await p).toBeUndefined();
    expect(spawns).toBe(1); // fatal — no retry
    expect(errs.some((e) => /needs cloudflared/.test(e))).toBe(true);
  });

  it("times out a live cloudflared that never prints a URL (no unbounded add/dev hang)", async () => {
    vi.useFakeTimers();
    const errs = captureErrors();
    const children: ChildProcess[] = [];
    const p = startCloudflareTunnel(
      8800,
      () => {
        const child = fakeCloudflared();
        children.push(child);
        return child;
      },
      100,
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.advanceTimersByTimeAsync(100);
      if (attempt < 3) await vi.advanceTimersByTimeAsync(TUNNEL_RETRY_MS);
    }
    expect(await p).toBeUndefined();
    expect(children).toHaveLength(3);
    for (const child of children) expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(errs.some((e) => /timed out after/.test(e))).toBe(true);
  });

  it("does not fail silently: an exit-before-URL is logged and retried, then it gives up", async () => {
    vi.useFakeTimers();
    const errs = captureErrors();
    let spawns = 0;
    const p = startCloudflareTunnel(8800, () => {
      spawns++;
      const child = fakeCloudflared();
      queueMicrotask(() => child.emit("exit", 1, null)); // every attempt exits before a URL
      return child;
    });
    await vi.advanceTimersByTimeAsync(TUNNEL_RETRY_MS * 3 + 100); // through both retry backoffs
    expect(await p).toBeUndefined();
    expect(spawns).toBe(3); // retried, not a single silent attempt
    expect(errs.some((e) => /exited before a public URL/.test(e) && /retrying/.test(e))).toBe(true);
    expect(errs.some((e) => /Serving without a tunnel/.test(e))).toBe(true);
  });
});

describe("tunnel: hasTunnelConnection", () => {
  it("recognises cloudflared's edge-connection line", () => {
    expect(hasTunnelConnection("2026 INF Registered tunnel connection connIndex=0 ip=198.41.200.63")).toBe(true);
  });

  it("never reads the URL banner or a failed dial as a connection", () => {
    expect(hasTunnelConnection("INF |  https://blue-cat-42.trycloudflare.com  |")).toBe(false);
    // Seen live on a network that blocks cloudflared's QUIC: it retries this forever, never connects,
    // and the hostname is never published — the case the timeout branch exists to name.
    expect(
      hasTunnelConnection(
        '2026 ERR Failed to dial a quic connection error="failed to dial to edge with quic: timeout" connIndex=0',
      ),
    ).toBe(false);
  });
});

describe("tunnel: parseTunnelUrl", () => {
  it("extracts a trycloudflare URL from cloudflared output", () => {
    expect(parseTunnelUrl("2026 INF +--+ https://blue-cat-42.trycloudflare.com +--+")).toBe(
      "https://blue-cat-42.trycloudflare.com",
    );
    expect(parseTunnelUrl("starting tunnel, registering connection…")).toBeUndefined();
  });

  it("never mistakes cloudflared's API endpoint in an ERROR line for the assigned tunnel URL", () => {
    // Seen live (0.8.0 release verification): a flaky proxy made cloudflared print its request
    // endpoint in an error, and the webhook got registered against Cloudflare's API host.
    expect(
      parseTunnelUrl(
        '2026 ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded',
      ),
    ).toBeUndefined();
    // …and an error line followed by the real assigned URL still resolves to the real one.
    expect(
      parseTunnelUrl(
        'ERR Post "https://api.trycloudflare.com/tunnel": timeout\nINF |  https://adams-columbus-organizing-portion.trycloudflare.com  |',
      ),
    ).toBe("https://adams-columbus-organizing-portion.trycloudflare.com");
  });
});

describe("tunnel: announceWebhooks", () => {
  // announceWebhooks registers straight away — the platform's own URL verification is the readiness
  // probe, so the stub only has to answer the platform API call.
  const setWebhookCall = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.find((c) => String(c[0]).includes("setWebhook")) as [string, RequestInit] | undefined;

  it("auto-registers the telegram webhook with the public URL + secret when env is set", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = "BOT";
    process.env.TELEGRAM_SECRET_TOKEN = "sek";
    const dir = await workspace(["telegram"]);

    await announceWebhooks(dir, "https://x.trycloudflare.com", declaredChannels(["telegram"]));

    const call = setWebhookCall(fetchMock);
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("https://api.telegram.org/botBOT/setWebhook");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      url: "https://x.trycloudflare.com/telegram",
      secret_token: "sek",
    });
  });

  it("does not call setWebhook when telegram env is missing (prints the manual URL instead)", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const dir = await workspace(["telegram"]);

    await announceWebhooks(dir, "https://x.trycloudflare.com", declaredChannels(["telegram"]));

    expect(setWebhookCall(fetchMock)).toBeUndefined();
    expect(errs.some((e) => /set TELEGRAM_BOT_TOKEN/.test(e) && /x\.trycloudflare\.com\/telegram/.test(e))).toBe(true);
  });

  it("prints the github webhook URL to paste into repo settings (no auto-registration)", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const dir = await workspace(["github"]);

    await announceWebhooks(dir, "https://x.trycloudflare.com", declaredChannels(["github"]));

    expect(setWebhookCall(fetchMock)).toBeUndefined();
    expect(errs.some((e) => /github:/.test(e) && /x\.trycloudflare\.com\/webhook/.test(e))).toBe(true);
  });

  it("prints Slack's manual Event Subscriptions URL", async () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message) => errs.push(String(message)));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const dir = await workspace(["slack"]);

    await announceWebhooks(dir, "https://x.trycloudflare.com", declaredChannels(["slack"]));

    expect(errs.some((line) => /slack:/.test(line) && /x\.trycloudflare\.com\/slack/.test(line))).toBe(true);
  });

  it("auto-updates an onboarded Slack app from owner-local state", async () => {
    const errs = captureErrors();
    const dir = await workspace(["slack"]);
    const stateRoot = join(dir, ".fastagent");
    writeSlackOnboardingState(stateRoot, {
      ...newSlackOnboardingState({
        appName: "Agent",
        groupBehavior: "mentions",
        configToken: "xoxe.config",
        configRefreshToken: "xoxe-refresh",
      }),
      appId: "A1",
      installedAt: new Date().toISOString(),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/health")) return new Response("ok");
      const body = JSON.parse(String(init?.body)) as { app_id?: string; manifest?: string };
      expect(body.app_id).toBe("A1");
      expect(JSON.parse(body.manifest ?? "{}")).toMatchObject({
        settings: { event_subscriptions: { request_url: "https://x.trycloudflare.com/slack" } },
      });
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await announceWebhooks(dir, "https://x.trycloudflare.com", declaredChannels(["slack"]), { stateRoot });

    expect(errs.some((line) => /slack: Event Subscriptions Request URL registered/.test(line))).toBe(true);
  });

  it("uses the validated route-channel subset and never registers an excluded WebSocket channel", async () => {
    process.env.FEISHU_APP_ID = "cli_app";
    process.env.FEISHU_APP_SECRET = "secret";
    const fetchMock = vi.fn(async () => new Response("must not call", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const dir = await workspace(["feishu"]);

    await announceWebhooks(dir, "https://x.trycloudflare.com", declaredChannels(["feishu"], "long-connection"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the exact Lark app page when the config API requires manual registration", async () => {
    captureErrors();
    process.env.LARK_APP_ID = "cli_app";
    process.env.LARK_APP_SECRET = "sec";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) return new Response(null, { status: 200 });
        if (url.includes("tenant_access_token")) {
          return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
        }
        if (url.includes("/application/v7/applications/")) return new Response("not found", { status: 404 });
        return new Response(null, { status: 404 });
      }),
    );
    const openUrl = vi.fn();
    const dir = await workspace(["lark"]);

    await announceWebhooks(dir, "https://x.trycloudflare.com", declaredChannels(["lark"]), { openUrl });

    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("https://open.larksuite.com/app/cli_app/event");
  });

  const setWebhookCount = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.filter((c) => String(c[0]).includes("setWebhook")).length;

  it("retries setWebhook through a transient error (tunnel not yet resolvable), then succeeds", async () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    process.env.TELEGRAM_BOT_TOKEN = "BOT";
    process.env.TELEGRAM_SECRET_TOKEN = "sek";
    const dir = await workspace(["telegram"]);
    const fetchMock = webhookFetch([
      { status: 400, body: '{"ok":false,"description":"Bad Request: bad webhook: Failed to resolve host"}' },
      { status: 200, body: '{"ok":true}' },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const p = announceWebhooks(dir, "https://x.trycloudflare.com", declaredChannels(["telegram"]));
    await vi.advanceTimersByTimeAsync(REGISTRATION_RETRY_MS); // spend the backoff without spending it
    await p;

    expect(setWebhookCount(fetchMock)).toBe(2); // retried once, then registered
    expect(errs.some((e) => /webhook registered/.test(e))).toBe(true);
  });

  it("does not crash the server when .env is unreadable — warns and continues best-effort", async () => {
    // Regression: loadDotEnv throws on a NON-ENOENT read error (here .env is a directory → EISDIR).
    // announceWebhooks is void-called with no unhandledRejection handler, so an uncaught throw would
    // terminate the long-running dev/start server. It must warn (surface the error) and continue.
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const dir = await workspace([]); // no channels → returns right after the .env read
    await mkdir(join(dir, ".secrets", ".env"), { recursive: true }); // a directory at the .env path → loadDotEnv throws EISDIR, not ENOENT

    // No channels, so nothing to register — the point is that it RESOLVES rather than throwing.
    await expect(announceWebhooks(dir, "https://x.trycloudflare.com", declaredChannels([]))).resolves.toEqual([]);
    expect(errs.some((e) => /could not read/.test(e) && /\.env/.test(e))).toBe(true); // surfaced, not silent
  });

  it("does not retry a permanent setWebhook error; prints the manual URL immediately", async () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    process.env.TELEGRAM_BOT_TOKEN = "BOT";
    process.env.TELEGRAM_SECRET_TOKEN = "sek";
    const dir = await workspace(["telegram"]);
    const fetchMock = webhookFetch([
      { status: 400, body: '{"ok":false,"description":"Bad Request: bad webhook: HTTPS url must be provided"}' },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const p = announceWebhooks(dir, "https://x.trycloudflare.com", declaredChannels(["telegram"]));
    await vi.advanceTimersByTimeAsync(20000); // well past any retry window
    await p;

    expect(setWebhookCount(fetchMock)).toBe(1); // permanent error → no retry
    expect(errs.some((e) => /Register manually/.test(e))).toBe(true);
  });
});
