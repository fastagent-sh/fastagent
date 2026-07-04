/**
 * `--tunnel` webhook registration for the telegram channel — TELEGRAM-domain logic invoked by the
 * tunnel's channel dispatch (tunnel.ts orchestrates cloudflared; what "registering telegram" means
 * lives here, beside the channel it serves). Reads the same .env tokens the channel itself uses.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { log } from "../../log.ts";
import { callApi } from "./telegram-api.ts";

/** Register `<baseUrl>/telegram` as the bot's webhook (with the .env secret), retrying while a fresh
 *  tunnel's DNS settles. Missing tokens print the manual instruction instead of failing the tunnel. */
export async function registerTelegramWebhook(baseUrl: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_SECRET_TOKEN;
  const webhookUrl = `${baseUrl}/telegram`;
  if (!botToken || !secret) {
    log.info(
      `[fastagent] telegram: set TELEGRAM_BOT_TOKEN + TELEGRAM_SECRET_TOKEN in .env, then re-run to auto-register. Webhook URL: ${webhookUrl}`,
    );
    return;
  }
  // Backstop after the tunnel's health poll: Telegram's resolver may lag it by a moment. The call
  // itself rides the channel's hardened pipeline (timeout, ok-validation, named failures) — a thrown
  // timeout stringifies with "timeout" in it, so the transient regex below catches it.
  const ATTEMPTS = 3;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(5000);
    try {
      await callApi("https://api.telegram.org", botToken, "setWebhook", { url: webhookUrl, secret_token: secret });
      log.info(`[fastagent] telegram: webhook registered → ${webhookUrl}`);
      return;
    } catch (e) {
      // Only network-transient errors are worth retrying. A fresh tunnel's "bad webhook: Failed to
      // resolve host" is caught by `resolve host`; a permanent "Bad webhook: HTTPS url must be provided"
      // is a config error, not transient, so `bad webhook` is deliberately NOT a trigger.
      const error = String(e);
      const transient = /resolve host|getaddrinfo|ENOTFOUND|fetch failed|ECONNRESET|timeout/i.test(error);
      if (!transient) {
        log.error(`[fastagent] telegram: setWebhook failed (${error}). Register manually with url=${webhookUrl}`);
        return;
      }
      if (attempt < ATTEMPTS - 1)
        log.warn(`[fastagent] telegram: tunnel not resolvable yet, retrying… (${attempt + 1}/${ATTEMPTS - 1})`);
    }
  }
  log.warn(
    `[fastagent] telegram: webhook still failing after retries (the tunnel may need another moment). Register manually with url=${webhookUrl}`,
  );
}
