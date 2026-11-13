import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredChannels } from "../../../src/channels/discover.ts";
import { announceWebhooks } from "../../../src/tunnel.ts";

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
