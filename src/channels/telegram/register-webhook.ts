/**
 * Telegram webhook registration — the TELEGRAM-domain step both `--tunnel` (dev, tunnel.ts) and
 * `deploy … --run` (the host runners' post-deploy step) invoke. What "registering telegram" means lives
 * here, beside the channel it serves; it reads the same .env tokens the channel uses.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { log } from "../../log.ts";
import { waitForHealth } from "../wait-health.ts";
import { callApi } from "./telegram-api.ts";

/**
 * Register `<baseUrl>/telegram` as the bot's webhook (with the .env secret). Waits for the server to be
 * REACHABLE first — polling `<baseUrl>/health` — because Telegram VERIFIES the URL when you set it, and a
 * fresh deploy's container (healthcheck + routing) or a fresh tunnel's DNS is not routable for some
 * seconds after the deploy/tunnel command returns. Tracking real readiness (not a fixed timer) is what
 * fixes the race that made the first real deploy need a manual `setWebhook`. Missing tokens print the
 * manual instruction instead of failing. `opts` (timeouts) exist for tests; production uses the defaults.
 */
export async function registerTelegramWebhook(
  baseUrl: string,
  opts: { readyTimeoutMs?: number; readyIntervalMs?: number; retryMs?: number } = {},
): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_SECRET_TOKEN;
  const webhookUrl = `${baseUrl}/telegram`;
  if (!botToken || !secret) {
    log.info(
      `[fastagent] telegram: set TELEGRAM_BOT_TOKEN + TELEGRAM_SECRET_TOKEN in .env, then re-run to auto-register. Webhook URL: ${webhookUrl}`,
    );
    return;
  }

  // Align registration with the server actually serving. Don't setWebhook against a URL Telegram can't
  // yet reach — it would fail, and a fixed retry window guesses the readiness delay (the deploy race).
  log.info(`[fastagent] telegram: waiting for ${baseUrl} to be reachable before registering the webhook…`);
  const ready = await waitForHealth(`${baseUrl}/health`, opts.readyTimeoutMs ?? 120_000, opts.readyIntervalMs ?? 3_000);
  if (!ready) {
    log.warn(
      `[fastagent] telegram: ${baseUrl}/health did not come up in time — the app may still be starting. ` +
        `Register the webhook manually once it's up: curl "https://api.telegram.org/bot<token>/setWebhook" -d url=${webhookUrl} -d secret_token=<secret>`,
    );
    return;
  }

  // Reachable → register. A short retry backstops Telegram's resolver lagging /health by a moment; only
  // network-transient errors retry (a permanent "bad webhook" config error is reported, not retried).
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(opts.retryMs ?? 2000);
    try {
      await callApi("https://api.telegram.org", botToken, "setWebhook", { url: webhookUrl, secret_token: secret });
      log.info(`[fastagent] telegram: webhook registered → ${webhookUrl}`);
      return;
    } catch (e) {
      const error = String(e);
      if (!/resolve host|getaddrinfo|ENOTFOUND|fetch failed|ECONNRESET|timeout/i.test(error)) {
        log.error(`[fastagent] telegram: setWebhook failed (${error}). Register manually with url=${webhookUrl}`);
        return;
      }
    }
  }
  log.warn(`[fastagent] telegram: setWebhook still failing after retries. Register manually with url=${webhookUrl}`);
}
