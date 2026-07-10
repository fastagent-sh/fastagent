/**
 * Lark event-URL registration — the LARK-domain step both `--tunnel` (dev, tunnel.ts) and
 * `deploy … --run` (the host runners' post-deploy step) invoke. What "registering lark" means lives
 * here, beside the channel it serves; it reads the same .env credentials the channel uses.
 *
 * Mechanism: the application-v7 config PATCH (`updateEventSubscription`) flips the app's event
 * subscription to webhook mode and points it at `<baseUrl>/lark`. Two properties make this the full
 * telegram-setWebhook parity: the platform applies a request-URL change IMMEDIATELY (no version
 * publish), and it VERIFIES the URL with a url_verification challenge during the PATCH — which is why
 * this waits for `<baseUrl>/health` to serve first (the same readiness race the telegram registrar
 * fixes). Requires the `application:application:self_manage` scope (the platform's agent-app template
 * includes it); without it the PATCH fails visibly and the manual console instruction is printed.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { log } from "../../log.ts";
import { waitForHealth } from "../wait-health.ts";
import { createLarkApi } from "./lark-api.ts";

/**
 * Register `<baseUrl>/lark` as the app's event Request URL (webhook mode). Missing credentials print
 * the manual instruction instead of failing. `opts` (timeouts) exist for tests; production defaults.
 */
export async function registerLarkWebhook(
  baseUrl: string,
  opts: { readyTimeoutMs?: number; readyIntervalMs?: number; retryMs?: number } = {},
): Promise<void> {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  const apiBase = process.env.LARK_BASE_URL || "https://open.feishu.cn";
  const requestUrl = `${baseUrl}/lark`;
  const manual = `set the event Request URL in the developer console (Events & Callbacks) to ${requestUrl} — keep the server running while you save (the console verifies the URL with a challenge)`;
  if (!appId || !appSecret) {
    log.info(`[fastagent] lark: set LARK_APP_ID + LARK_APP_SECRET in .env, then re-run to auto-register. Or ${manual}`);
    return;
  }

  // Align registration with the server actually serving: the PATCH triggers the platform's
  // url_verification challenge against requestUrl — registering before /health serves would fail.
  log.info(`[fastagent] lark: waiting for ${baseUrl} to be reachable before registering the event URL…`);
  const ready = await waitForHealth(`${baseUrl}/health`, opts.readyTimeoutMs ?? 120_000, opts.readyIntervalMs ?? 3_000);
  if (!ready) {
    log.warn(`[fastagent] lark: ${baseUrl}/health did not come up in time — the app may still be starting. ${manual}`);
    return;
  }

  const api = createLarkApi({ baseUrl: apiBase, appId, appSecret });
  // Reachable → register. A short retry backstops transient network errors only; a permanent config
  // error (missing scope, app under review) is reported with the manual path, not retried.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(opts.retryMs ?? 2000);
    try {
      await api.updateEventSubscription(appId, { subscriptionType: "webhook", requestUrl });
      log.info(`[fastagent] lark: event Request URL registered → ${requestUrl}`);
      return;
    } catch (e) {
      const error = String(e);
      if (!/resolve host|getaddrinfo|ENOTFOUND|fetch failed|ECONNRESET|timeout/i.test(error)) {
        log.error(
          `[fastagent] lark: could not register the event URL (${error}). ` +
            `If the app lacks the "application:application:self_manage" scope or is under review, ${manual}`,
        );
        return;
      }
    }
  }
  log.warn(`[fastagent] lark: registration still failing after retries. ${manual}`);
}
