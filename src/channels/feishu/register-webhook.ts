/**
 * Feishu/Lark event-URL registration — the platform-domain step both `--tunnel` (dev, tunnel.ts) and
 * `deploy … --run` (the host runners' post-deploy step) invoke, once per mounted kind. What
 * "registering feishu/lark" means lives here, beside the engine it serves; it reads the same .env
 * credentials the channel of that kind uses (`FEISHU_*` / `LARK_*`).
 *
 * Mechanism: the application-v7 config PATCH (`updateEventSubscription`) flips the app's event
 * subscription to webhook mode and points it at `<baseUrl>/<kind>`. Two properties make this the full
 * telegram-setWebhook parity: the platform applies a request-URL change IMMEDIATELY (no version
 * publish), and it VERIFIES the URL with a url_verification challenge during the PATCH — which is why
 * this waits for `<baseUrl>/health` to serve first (the same readiness race the telegram registrar
 * fixes). Requires the `application:application:patch` scope (field-tested: `self_manage` does NOT
 * cover this PATCH) — `add feishu` requests it at creation via addons; without it the PATCH fails
 * visibly and the manual console instruction is printed.
 *
 * CLOUD LAG: the application-v7 config API exists on open.feishu.cn but (as of 2026-07) is NOT
 * deployed on open.larksuite.com — the route 404s there. The registrar still attempts it (the day the
 * platform ships it, registration starts working with no change here) and names the real cause in the
 * fallback instead of blaming the app's scopes.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { log } from "../../log.ts";
import { waitForHealth } from "../wait-health.ts";
import { type FeishuCloudKind, cloudFor } from "./cloud.ts";
import { createFeishuApi } from "./feishu-api.ts";

/**
 * Register `<baseUrl>/<kind>` as the app's event Request URL (webhook mode). Missing credentials print
 * the manual instruction instead of failing. `opts` exist for tests: timeouts + `apiBase` (a fake
 * platform — production derives it from the kind).
 */
export interface FeishuManualRegistration {
  consoleUrl: string;
  requestUrl: string;
}

export interface RegisterFeishuWebhookOptions {
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  retryMs?: number;
  apiBase?: string;
  /** Manual fallback after a definitive config error or exhausted retries. Local dev opens this App. */
  onManualRegistration?: (info: FeishuManualRegistration) => void;
}

export async function registerFeishuWebhook(
  baseUrl: string,
  kind: FeishuCloudKind,
  opts: RegisterFeishuWebhookOptions = {},
): Promise<void> {
  const profile = cloudFor(kind);
  const envPrefix = profile.envPrefix;
  const appId = process.env[`${envPrefix}_APP_ID`];
  const appSecret = process.env[`${envPrefix}_APP_SECRET`];
  const apiBase = opts.apiBase ?? profile.apiBase;
  const requestUrl = `${baseUrl}/${kind}`;
  const manual = `switch Subscription mode to webhook and set the event Request URL in the developer console (Events & Callbacks) to ${requestUrl} — keep the server running while you save (the console verifies the URL with a challenge)`;
  if (!appId || !appSecret) {
    log.info(
      `[fastagent] ${kind}: set ${envPrefix}_APP_ID + ${envPrefix}_APP_SECRET in .env, then re-run to auto-register. Or ${manual}`,
    );
    return;
  }

  // Align registration with the server actually serving: the PATCH triggers the platform's
  // url_verification challenge against requestUrl — registering before /health serves would fail.
  log.info(`[fastagent] ${kind}: waiting for ${baseUrl} to be reachable before registering the event URL…`);
  const ready = await waitForHealth(`${baseUrl}/health`, opts.readyTimeoutMs ?? 120_000, opts.readyIntervalMs ?? 3_000);
  if (!ready) {
    log.warn(
      `[fastagent] ${kind}: ${baseUrl}/health did not come up in time — the app may still be starting. ${manual}`,
    );
    return;
  }

  const api = createFeishuApi({ kind, baseUrl: apiBase, appId, appSecret });
  const consoleUrl = `${apiBase}/app/${encodeURIComponent(appId)}/event`;
  const versionUrl = `${apiBase}/app/${encodeURIComponent(appId)}/version`;
  const manualRegistration = (): void => {
    log.info(`[fastagent] ${kind}: Events & Callbacks:\n  ${consoleUrl}`);
    log.info(
      `[fastagent] ${kind}: switch Subscription mode to webhook and copy this Request URL:\n  ${requestUrl}\n` +
        `  Keep fastagent running while saving — the console verifies the URL immediately.`,
    );
    log.info(
      `[fastagent] ${kind}: if this app's webhook mode has not been published yet, ` +
        `create + publish a version before testing messages:\n  ${versionUrl}`,
    );
    try {
      opts.onManualRegistration?.({ consoleUrl, requestUrl });
    } catch (callbackError) {
      log.warn(`[fastagent] ${kind}: could not open Events & Callbacks: ${String(callbackError)}`);
    }
  };

  // Reachable → register. The PATCH is the real probe (same lesson as the token bootstrap): the
  // platform verifies request_url with a challenge DURING the call, and a fresh tunnel's edge can be
  // reachable from here while the platform's own path still lags — its 210042 "request_url validation
  // failed" is therefore retried with backoff, alongside transient network errors. Only a permanent
  // config error (missing scope, app under review, the intl 404) is reported once with the manual path.
  const attempts = 8;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(opts.retryMs ?? 10_000);
    try {
      await api.updateEventSubscription(appId, { subscriptionType: "webhook", requestUrl });
      log.info(`[fastagent] ${kind}: event Request URL registered → ${requestUrl}`);
      // Field-tested: a URL change applies immediately, but the MODE flip (the template's long
      // connection → webhook) only takes effect when a version is published — the dispatcher serves
      // the published snapshot, and version publishing has no open API. One console click, once.
      log.info(
        `[fastagent] ${kind}: if messages do not arrive, publish a version (one click, prompted) — the switch to webhook mode takes effect on publish: ${versionUrl}`,
      );
      return;
    } catch (e) {
      const error = String(e);
      // A 404 on the config route is the CLOUD lagging, not this app's configuration: the v7 API is
      // live on open.feishu.cn but not yet on open.larksuite.com. Name that — "check your scopes"
      // would send the operator hunting for a problem they cannot fix.
      if (/failed: 404/.test(error)) {
        log.warn(
          `[fastagent] ${kind}: this cloud (${apiBase}) returned HTTP 404 for the app-config API — ` +
            `manual registration is required`,
        );
        manualRegistration();
        return;
      }
      if (!/resolve host|getaddrinfo|ENOTFOUND|fetch failed|ECONNRESET|timeout|210042|request_url/i.test(error)) {
        log.error(
          `[fastagent] ${kind}: could not register the event URL (${error}). ` +
            `The app may lack the "application:application:patch" scope (console → Permissions) or be under review; manual registration is available below.`,
        );
        manualRegistration();
        return;
      }
    }
  }
  log.warn(`[fastagent] ${kind}: registration still failing after retries — manual registration is required`);
  manualRegistration();
}
