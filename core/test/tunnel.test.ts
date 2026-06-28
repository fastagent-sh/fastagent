import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceWebhooks, parseTunnelUrl } from "../src/tunnel.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_SECRET_TOKEN;
});

async function workspace(channels: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-tunnel-"));
  await mkdir(join(dir, "channels"), { recursive: true });
  for (const c of channels) await writeFile(join(dir, "channels", `${c}.ts`), "export default () => ({});\n");
  return dir;
}

describe("tunnel: parseTunnelUrl", () => {
  it("extracts a trycloudflare URL from cloudflared output", () => {
    expect(parseTunnelUrl("2026 INF +--+ https://blue-cat-42.trycloudflare.com +--+")).toBe(
      "https://blue-cat-42.trycloudflare.com",
    );
    expect(parseTunnelUrl("starting tunnel, registering connection…")).toBeUndefined();
  });
});

describe("tunnel: announceWebhooks", () => {
  it("auto-registers the telegram webhook with the public URL + secret when env is set", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = "BOT";
    process.env.TELEGRAM_SECRET_TOKEN = "sek";
    const dir = await workspace(["telegram"]);

    await announceWebhooks(dir, "https://x.trycloudflare.com");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botBOT/setWebhook");
    expect(JSON.parse(String(init.body))).toMatchObject({
      url: "https://x.trycloudflare.com/telegram",
      secret_token: "sek",
    });
  });

  it("does not call setWebhook when telegram env is missing (prints the manual URL instead)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const dir = await workspace(["telegram"]);

    await announceWebhooks(dir, "https://x.trycloudflare.com");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errs.some((e) => /set TELEGRAM_BOT_TOKEN/.test(e) && /x\.trycloudflare\.com\/telegram/.test(e))).toBe(true);
  });

  it("prints the github webhook URL to paste into repo settings (no auto-registration)", async () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    const dir = await workspace(["github"]);

    await announceWebhooks(dir, "https://x.trycloudflare.com");

    expect(errs.some((e) => /github:/.test(e) && /x\.trycloudflare\.com\/webhook/.test(e))).toBe(true);
  });
});
