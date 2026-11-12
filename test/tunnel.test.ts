import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredChannels } from "../src/channels/discover.ts";
import { TUNNEL_DNS_LAG_MS, announceWebhooks, startCloudflareTunnel } from "../src/tunnel.ts";

/** A fake cloudflared child: EventEmitter with stdout/stderr emitters, drivable from a test. */
function fakeCloudflared(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  return child as unknown as ChildProcess;
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
});
