import type { FeishuGroupBehavior, FeishuSubscriptionMode } from "../feishu/setup-mode.ts";

/**
 * Guided Lark-international onboarding. The intl cloud cannot complete the BOUND scan-to-create flow,
 * so a new/partial setup opens its unbound one-click launcher and collects one App-scoped credential
 * set; a complete existing ID/Secret pair resumes that App directly. Then optimistically run Feishu's
 * webhook-mode + Verification-Token bootstrap against THIS app: a successful PATCH captures the token
 * and flips Subscription mode; only a definitive config-route 404 falls back to the token the console
 * displays + a manual mode switch. IO is injected so the workflow is testable without a terminal or
 * browser.
 */

export const LARK_CONSOLE_URL = "https://open.larksuite.com/page/launcher?from=backend_oneclick";

/** Directly where the fallback token lives (and where the successful automatic mode change is visible). */
export function larkEventSecurityUrl(appId: string): string {
  return `https://open.larksuite.com/app/${encodeURIComponent(appId)}/event?tab=safe`;
}

export interface LarkOnboardIO {
  openUrl(url: string): void;
  note(message: string): void;
  prompt(message: string, opts?: { hidden?: boolean }): Promise<string | undefined>;
}

interface LarkBootstrapResult {
  /** Challenge-captured token: the PATCH also switched Subscription mode to webhook. */
  token?: string;
  /** Present only for a definitive config-route 404; tells the user why the manual path is active. */
  manualReason?: string;
}

export interface LarkOnboardOptions {
  /** Existing active .env values. A complete credential pair is reused (and still validated). */
  existing?: Readonly<Record<string, string | undefined>>;
  ingress?: FeishuSubscriptionMode;
  groupBehavior?: FeishuGroupBehavior;
  verifyCredentials(appId: string, appSecret: string): Promise<void>;
  bootstrapWebhook?(appId: string, appSecret: string): Promise<LarkBootstrapResult>;
}

export interface LarkOnboardCredentials {
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  LARK_VERIFICATION_TOKEN?: string;
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required — re-run \`fastagent add lark\` to continue setup`);
  return trimmed;
}

/** Open the stable app console and collect everything the runtime needs. Cancellation is a visible
 * failure: the scaffold remains and `add lark` is deliberately re-runnable to resume onboarding. */
export async function onboardLarkApp(io: LarkOnboardIO, opts: LarkOnboardOptions): Promise<LarkOnboardCredentials> {
  const existingId = opts.existing?.LARK_APP_ID?.trim();
  const existingSecret = opts.existing?.LARK_APP_SECRET?.trim();
  const reuseExistingApp = Boolean(existingId && existingSecret);

  // Credentials are one App-scoped set. Reuse only a COMPLETE ID/Secret pair; a partial pair starts a
  // fresh launcher/input path, and its unrelated old Token must not be attached to the newly-entered App.
  if (reuseExistingApp) {
    io.note(`Reusing Lark app ${existingId}; opening its Events & Callbacks configuration directly.`);
  } else {
    io.note(`Create the app on Lark's one-click launcher. Opening ${LARK_CONSOLE_URL}`);
    io.openUrl(LARK_CONSOLE_URL);
  }
  const appId = required(
    reuseExistingApp ? existingId : await io.prompt("LARK_APP_ID (Credentials & Basic Info)", { hidden: false }),
    "LARK_APP_ID",
  );
  const appSecret = required(
    reuseExistingApp ? existingSecret : await io.prompt("LARK_APP_SECRET (Credentials & Basic Info)", { hidden: true }),
    "LARK_APP_SECRET",
  );

  await opts.verifyCredentials(appId, appSecret);
  const eventSecurityUrl = larkEventSecurityUrl(appId);
  io.note(`App ID / Secret verified. Opening Events & Callbacks → Security: ${eventSecurityUrl}`);
  io.openUrl(eventSecurityUrl);
  if (opts.ingress === "websocket") {
    io.note(
      opts.groupBehavior === "mentions"
        ? "Choose long connection, subscribe im.message.receive_v1, then create + publish an app version. No Verification Token or Request URL is needed."
        : "Choose long connection and subscribe im.message.receive_v1, but do not publish yet — context-aware group permission setup follows. No Verification Token or Request URL is needed.",
    );
    return { LARK_APP_ID: appId, LARK_APP_SECRET: appSecret };
  }
  io.note("Trying automatic webhook-mode + Verification-Token bootstrap…");
  if (!opts.bootstrapWebhook) throw new Error("Lark webhook onboarding requires bootstrapWebhook");
  const bootstrap = await opts.bootstrapWebhook(appId, appSecret);
  if (bootstrap.token) {
    io.note("Verification Token captured; Subscription mode changed to webhook in the app draft.");
  } else {
    io.note(
      `${bootstrap.manualReason ?? "Automatic bootstrap unavailable."} Open Events & Callbacks → Encryption Strategy and copy the Verification Token. You must also switch Subscription mode to webhook when setting the Request URL.`,
    );
  }

  const verificationToken = required(
    bootstrap.token ||
      (reuseExistingApp ? opts.existing?.LARK_VERIFICATION_TOKEN?.trim() : undefined) ||
      (await io.prompt("LARK_VERIFICATION_TOKEN (Events & Callbacks → Encryption Strategy)", { hidden: true })),
    "LARK_VERIFICATION_TOKEN",
  );

  return {
    LARK_APP_ID: appId,
    LARK_APP_SECRET: appSecret,
    LARK_VERIFICATION_TOKEN: verificationToken,
  };
}
