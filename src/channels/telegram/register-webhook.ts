/**
 * Telegram webhook registration — the TELEGRAM-domain step both `--tunnel` (dev, tunnel.ts) and `deploy … --run` (the
 * host runners' post-deploy step) invoke.
 */
import { log } from "../../log.ts";
import { retryWhile, type RegistrationOutcome } from "../registration.ts";
import { callApi } from "./telegram-api.ts";

/** Whether a setWebhook failure is the URL still warming up rather than a configuration error. */
function isTransientRegistrationError(error: string): boolean {
  return /resolve host|getaddrinfo|ENOTFOUND|fetch failed|ECONNRESET|timeout|timed out|connection refused|can't connect|connection to the host|wrong response from the webhook/i.test(
    error,
  );
}

/**
 * Register `<baseUrl>/telegram` as the bot's webhook (with the .env secret). Missing tokens print the
 * manual instruction instead of failing. `opts` carries the attempt budget: `--tunnel` takes the
 * default, `deploy --run` passes `DEPLOY_REGISTRATION_ATTEMPTS` (a host starts slower than a tunnel),
 * and tests shrink it.
 *
 * Reports its outcome as a {@link RegistrationOutcome} fact; gating policy belongs to the caller.
 */
export async function registerTelegramWebhook(
  baseUrl: string,
  opts: { attempts?: number; retryMs?: number } = {},
): Promise<RegistrationOutcome> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_SECRET_TOKEN;
  const webhookUrl = `${baseUrl}/telegram`;
  if (!botToken || !secret) {
    log.info(
      `[fastagent] telegram: set TELEGRAM_BOT_TOKEN + TELEGRAM_SECRET_TOKEN in .env, then re-run to auto-register. Webhook URL: ${webhookUrl}`,
    );
    return "manual";
  }

  log.info(`[fastagent] telegram: registering the webhook — Telegram verifies ${webhookUrl} as it does…`);
  try {
    await retryWhile(
      () => callApi("https://api.telegram.org", botToken, "setWebhook", { url: webhookUrl, secret_token: secret }),
      (error) => isTransientRegistrationError(String(error)),
      {
        attempts: opts.attempts,
        retryMs: opts.retryMs,
        onRetry: ({ attempt, attempts }) =>
          log.info(
            `[fastagent] telegram: Telegram cannot reach ${webhookUrl} yet (attempt ${attempt}/${attempts}); retrying…`,
          ),
      },
    );
    log.info(`[fastagent] telegram: webhook registered → ${webhookUrl}`);
    return "registered";
  } catch (e) {
    // Both endings leave the webhook unregistered and the operator with work to do, so both are ERROR; they differ
    // only in what to do about it.
    const error = String(e);
    log.error(
      isTransientRegistrationError(error)
        ? `[fastagent] telegram: Telegram could not reach ${webhookUrl} after retries (last error: ${error}). ` +
            `Once it is up, register manually: curl "https://api.telegram.org/bot<token>/setWebhook" -d url=${webhookUrl} -d secret_token=<secret>`
        : `[fastagent] telegram: setWebhook failed (${error}). Register manually with url=${webhookUrl}`,
    );
    return "failed";
  }
}
