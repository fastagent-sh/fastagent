/**
 * Feishu/Lark event-URL registration — the platform-domain step both `--tunnel` (dev, tunnel.ts) and `deploy … --run`
 * (the host runners' post-deploy step) invoke, once per mounted kind.
 */
import { log } from "../../log.ts";
import { retryWhile, type RegistrationOutcome } from "../registration.ts";
import { type FeishuCloudKind, cloudFor } from "./cloud.ts";
import { createFeishuApi, isFeishuConfigApiMissing, isTransientFeishuRegistrationError } from "./feishu-api.ts";

/** Register `<baseUrl>/<kind>` as the app's event Request URL (webhook mode). */
interface FeishuManualRegistration {
  consoleUrl: string;
  requestUrl: string;
}

export interface RegisterFeishuWebhookOptions {
  attempts?: number;
  retryMs?: number;
  apiBase?: string;
  /** Manual fallback after a definitive config error or exhausted retries. */
  onManualRegistration?: (info: FeishuManualRegistration) => void;
}

export async function registerFeishuWebhook(
  baseUrl: string,
  kind: FeishuCloudKind,
  opts: RegisterFeishuWebhookOptions = {},
): Promise<RegistrationOutcome> {
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
    return "manual";
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

  // The PATCH is the probe (same lesson as the token bootstrap).
  try {
    await retryWhile(
      () => api.updateEventSubscription(appId, { subscriptionType: "webhook", requestUrl }),
      isTransientFeishuRegistrationError,
      {
        attempts: opts.attempts,
        retryMs: opts.retryMs,
        onRetry: ({ attempt, attempts }) =>
          log.info(
            `[fastagent] ${kind}: the platform cannot verify ${requestUrl} yet (attempt ${attempt}/${attempts}); retrying…`,
          ),
      },
    );
    log.info(`[fastagent] ${kind}: event Request URL registered → ${requestUrl}`);
    // Field-tested: a URL change applies immediately, but the MODE flip (the template's long connection → webhook)
    // only takes effect when a version is published.
    log.info(
      `[fastagent] ${kind}: if messages do not arrive, publish a version (one click, prompted) — the switch to webhook mode takes effect on publish: ${versionUrl}`,
    );
    return "registered";
  } catch (e) {
    // A 404 on the config route is the CLOUD lagging, not this app's configuration: the v7 API is live on
    // open.feishu.cn but not yet on open.larksuite.com.
    if (isFeishuConfigApiMissing(e)) {
      log.warn(
        `[fastagent] ${kind}: this cloud (${apiBase}) returned HTTP 404 for the app-config API — ` +
          `manual registration is required`,
      );
      manualRegistration();
      return "manual"; // that cloud has no config API — the manual path is the norm there
    }
    // Exhausted retries end in the same state as a permanent config error (event URL not registered, manual action
    // required) — report at the same level.
    log.error(
      isTransientFeishuRegistrationError(e)
        ? `[fastagent] ${kind}: the platform could not verify ${requestUrl} after retries — manual registration is required`
        : `[fastagent] ${kind}: could not register the event URL (${String(e)}). ` +
            `The app may lack the "application:application:patch" scope (console → Permissions) or be under review; manual registration is available below.`,
    );
    manualRegistration();
    return "failed";
  }
}
