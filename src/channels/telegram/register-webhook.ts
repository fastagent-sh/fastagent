/**
 * Telegram webhook registration — the TELEGRAM-domain step both `--tunnel` (dev, tunnel.ts) and
 * `deploy … --run` (the host runners' post-deploy step) invoke. What "registering telegram" means lives
 * here, beside the channel it serves; it reads the same .env tokens the channel uses.
 *
 * READINESS IS setWebhook'S OWN VERDICT, not a local probe. Telegram VERIFIES the URL during the call,
 * from Telegram's network — which is the only network that has to reach it. This used to poll
 * `<baseUrl>/health` from here first, and that probe answered a different question badly: a freshly
 * minted hostname (a quick tunnel, a fresh deploy) is routinely unreachable from the machine running
 * the CLI for a minute or more — behind a proxy, or while its own resolver still says ENOTFOUND — long
 * after Telegram can reach it (#421). So the retry loop below IS the wait: Telegram's reachability
 * verdicts ("Failed to resolve host", "Wrong response from the webhook") are retried, and only a
 * configuration error the operator must fix is reported once.
 */
import { log } from "../../log.ts";
import { retryWhile, type RegistrationOutcome } from "../registration.ts";
import { callApi } from "./telegram-api.ts";

/**
 * Whether a setWebhook failure is the URL still warming up rather than a configuration error. Two
 * families: transport failures reaching Telegram at all, and Telegram's own verdict after it fails to
 * reach the webhook — which carries its connection layer's words verbatim (`Bad Request: bad webhook:
 * Connection timed out` / `Connection refused` for a host whose DNS answers before anything listens,
 * `Wrong response from the webhook: 530` for a tunnel edge without its origin). This is the ONLY gate
 * between "wait 70s" and "fail now", so it is wide on the reachability side. A permanent "bad webhook"
 * — an http:// URL, an unsupported port — matches nothing here and is reported.
 */
function isTransientRegistrationError(error: string): boolean {
  return /resolve host|getaddrinfo|ENOTFOUND|fetch failed|ECONNRESET|timeout|timed out|connection refused|can't connect|connection to the host|wrong response from the webhook/i.test(
    error,
  );
}

/**
 * Register `<baseUrl>/telegram` as the bot's webhook (with the .env secret). Missing tokens print the
 * manual instruction instead of failing. `opts` (attempt budget) exist for tests; production uses the
 * defaults.
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
    // Both endings leave the webhook unregistered and the operator with work to do, so both are ERROR;
    // they differ only in what to do about it.
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
