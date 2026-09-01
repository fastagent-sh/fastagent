/**
 * Telegram accepts a webhook we register against a live tunnel — the one step of the Telegram path
 * that no fake can stand in for, because Telegram itself decides it: `setWebhook` VERIFIES the URL
 * (DNS, TLS, reachability) before it stores it. A mocked Bot API always says yes.
 *
 * The chain, all product entries: `createAgentService` composes the surface (its `/health` is what the
 * registrar waits on) → `serveNode` binds it → `startCloudflareTunnel` publishes it →
 * `registerTelegramWebhook` waits for readiness and calls `setWebhook` → Telegram's own
 * `getWebhookInfo` is asked whether it kept what we sent.
 *
 * Scope: REGISTRATION, not delivery. A real inbound update needs a human to type into a chat, so the
 * probe stops where automation honestly ends. The agent dir declares no channel, which means no
 * `/telegram` route is mounted — Telegram verifies the URL at registration time and only POSTs to it
 * when a message arrives, so nothing here depends on that route existing.
 *
 * Needs `TELEGRAM_BOT_TOKEN` (a bot of its own — this test SETS and then DELETES that bot's webhook,
 * so pointing it at a bot serving real traffic would take that traffic down).
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { serveNode } from "../../src/channels/serve.ts";
import { registerTelegramWebhook } from "../../src/channels/telegram/register-webhook.ts";
import { createAgentService } from "../../src/engines/pi/service.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { startCloudflareTunnel } from "../../src/tunnel.ts";
import { requireEnv } from "./env.ts";

// Node's fetch ignores HTTPS_PROXY; the Bot API calls below and the registrar's own both need this.
installProxyFetch();

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
const BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN", "a bot token of this probe's OWN bot, from @BotFather");

// Every cleanup runs, in reverse, and failures surface together: the first one registered is a
// network call to Telegram, and a plain loop would let its failure skip the two below it — leaving a
// public *.trycloudflare.com URL pointed at this service's unauthenticated `POST /invoke`.
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.reverse()) {
    // The only catch here, and it hides nothing: it holds one failure so the cleanups after it still
    // run, then every one of them is rethrown together below.
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "cleanup failed");
});

/** One Bot API call, failing loudly: a non-ok body is a protocol answer, never something to absorb. */
async function botApi(method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? response.status}`);
  return json.result as Record<string, unknown>;
}

describe("telegram: registering a webhook against a live tunnel", () => {
  it("Telegram verifies the tunnel URL and keeps the webhook we registered", async () => {
    // The bot's webhook is global state on Telegram's side — clear it however this test ends.
    // `drop_pending_updates`, both here and before registering: Telegram queues updates for 24h while
    // no webhook is set and delivers them the instant `setWebhook` succeeds. No `/telegram` route is
    // mounted here, so a queued update would 404 and land in the `last_error_message` asserted below.
    cleanups.push(async () => {
      await botApi("deleteWebhook", { drop_pending_updates: true });
    });
    await botApi("deleteWebhook", { drop_pending_updates: true });

    const dir = await mkdtemp(join(tmpdir(), "fa-live-telegram-"));
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: ${JSON.stringify(MODEL)} };\n`);

    const service = await createAgentService(dir);
    const server = serveNode(service.handler, { port: 0, host: "127.0.0.1" });
    cleanups.push(() => server.close());
    const port = await server.listening;

    const tunnel = await startCloudflareTunnel(port);
    expect(tunnel, "cloudflared did not yield a quick-tunnel URL").toBeDefined();
    if (!tunnel) return;
    cleanups.push(() => tunnel.close());

    // The registrar reads both from the environment. The secret token is what the ingress compares on
    // every inbound update; minted per run so a probe never reuses a value that reached Telegram before.
    process.env.TELEGRAM_SECRET_TOKEN = randomBytes(16).toString("hex");

    // Registration waits for /health through the tunnel, then calls setWebhook — Telegram verifies the
    // URL itself, so "registered" is Telegram's verdict on the tunnel, not ours.
    const outcome = await registerTelegramWebhook(tunnel.url);
    expect(outcome, "telegram refused the webhook (see the registrar's log line for its reason)").toBe("registered");

    // Ask Telegram what it stored: the round trip, not just our own return value.
    const info = await botApi("getWebhookInfo");
    expect(info.url).toBe(`${tunnel.url}/telegram`);
    expect(info.last_error_message, "telegram recorded an error delivering to this URL").toBeUndefined();
  });
});
