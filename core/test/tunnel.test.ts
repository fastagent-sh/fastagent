import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceWebhooks, parseTunnelUrl, startCloudflareTunnel } from "../src/tunnel.ts";

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
  it("resolves a tunnel on the first URL cloudflared prints", async () => {
    const child = fakeCloudflared();
    const p = startCloudflareTunnel(8800, () => child);
    await Promise.resolve(); // let the listeners attach
    child.stderr?.emit("data", Buffer.from("INF +-+ https://blue-cat-42.trycloudflare.com +-+\n"));
    const t = await p;
    expect(t?.url).toBe("https://blue-cat-42.trycloudflare.com");
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

describe("tunnel: parseTunnelUrl", () => {
  it("extracts a trycloudflare URL from cloudflared output", () => {
    expect(parseTunnelUrl("2026 INF +--+ https://blue-cat-42.trycloudflare.com +--+")).toBe(
      "https://blue-cat-42.trycloudflare.com",
    );
    expect(parseTunnelUrl("starting tunnel, registering connection…")).toBeUndefined();
  });
});

describe("tunnel: announceWebhooks", () => {
  // announceWebhooks first polls <url>/health until the tunnel serves, then registers. The stub
  // returns 200 for everything, so the health poll passes on the first try.
  const setWebhookCall = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.find((c) => String(c[0]).includes("setWebhook")) as [string, RequestInit] | undefined;

  it("auto-registers the telegram webhook with the public URL + secret when env is set", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = "BOT";
    process.env.TELEGRAM_SECRET_TOKEN = "sek";
    const dir = await workspace(["telegram"]);

    await announceWebhooks(dir, "https://x.trycloudflare.com");

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

    await announceWebhooks(dir, "https://x.trycloudflare.com");

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

    await announceWebhooks(dir, "https://x.trycloudflare.com");

    expect(setWebhookCall(fetchMock)).toBeUndefined();
    expect(errs.some((e) => /github:/.test(e) && /x\.trycloudflare\.com\/webhook/.test(e))).toBe(true);
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

    const p = announceWebhooks(dir, "https://x.trycloudflare.com");
    await vi.advanceTimersByTimeAsync(6000); // past the 5s retry backoff
    await p;

    expect(setWebhookCount(fetchMock)).toBe(2); // retried once, then registered
    expect(errs.some((e) => /webhook registered/.test(e))).toBe(true);
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

    const p = announceWebhooks(dir, "https://x.trycloudflare.com");
    await vi.advanceTimersByTimeAsync(20000); // well past any retry window
    await p;

    expect(setWebhookCount(fetchMock)).toBe(1); // permanent error → no retry
    expect(errs.some((e) => /Register manually/.test(e))).toBe(true);
  });
});
