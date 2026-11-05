import { encodeAddons } from "../feishu/register-app.ts";
import { type FeishuSubscriptionMode, feishuAppAddons } from "../feishu/setup-mode.ts";

/** Guided Lark-international onboarding. */

/**
 * Lark's one-click launcher, where the person creates the app. The launcher is unbound (the bound confirm page is broken
 * on the international cloud), but it merges the `addons` query parameter onto the app it creates, as Feishu's does: the
 * scopes and the event the channel needs arrive with the app, so nothing is ticked in the console afterwards. A tenant
 * may still withhold a scope; the permission check that follows creation names it.
 */
export function larkConsoleUrl(ingress: FeishuSubscriptionMode): string {
  const url = new URL("https://open.larksuite.com/page/launcher");
  url.searchParams.set("from", "backend_oneclick");
  url.searchParams.set("addons", encodeAddons(feishuAppAddons(ingress)));
  return url.toString();
}

/** Directly where the fallback token lives (and where the successful automatic mode change is visible). */
export function larkEventSecurityUrl(appId: string): string {
  return `https://open.larksuite.com/app/${encodeURIComponent(appId)}/event?tab=safe`;
}

export interface LarkOnboardIO {
  /** A page for the person, and what they do there. */
  openUrl(url: string, action: string): void;
  note(message: string): void;
  prompt(message: string, opts?: { hidden?: boolean }): Promise<string | undefined>;
  verificationToken?(consoleUrl: string): Promise<string>;
  // A page must await check before accepting the pair: it includes durable persistence.
  collect?(input: {
    /** Lark's launcher, with what the channel needs set on the app it creates. */
    consoleUrl: string;
    check(appId: string, appSecret: string): Promise<void>;
  }): Promise<{ appId: string; appSecret: string }>;
}

interface LarkBootstrapResult {
  /** Challenge-captured token: the PATCH also switched Subscription mode to webhook. */
  token?: string;
  /** Present only for a definitive config-route 404; tells the user why the manual path is active. */
  manualReason?: string;
}

export interface LarkOnboardOptions {
  /** Existing active .env values. */
  existing?: Readonly<Record<string, string | undefined>>;
  ingress?: FeishuSubscriptionMode;
  verifyCredentials(appId: string, appSecret: string): Promise<void>;
  // Persist a newly verified pair before any subsequent setup can fail.
  keep?(appId: string, appSecret: string): Promise<void>;
  bootstrapWebhook?(appId: string, appSecret: string): Promise<LarkBootstrapResult>;
  /** The command that continues an interrupted setup: the one that started it (`add lark`, `deploy <host> --run`). */
  rerun?: string;
}

export interface LarkOnboardCredentials {
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  LARK_VERIFICATION_TOKEN?: string;
}

function required(value: string | undefined, name: string, rerun: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required — re-run \`${rerun}\` to continue setup`);
  return trimmed;
}

/** Open the stable app console and collect everything the runtime needs. */
export async function onboardLarkApp(io: LarkOnboardIO, opts: LarkOnboardOptions): Promise<LarkOnboardCredentials> {
  const rerun = opts.rerun ?? "fastagent add lark";
  const existingId = opts.existing?.LARK_APP_ID?.trim();
  const existingSecret = opts.existing?.LARK_APP_SECRET?.trim();
  const reuseExistingApp = Boolean(existingId && existingSecret);

  // Credentials are one App-scoped set.
  // No ingress named is the webhook path below (a deploy's production app).
  const consoleUrl = larkConsoleUrl(opts.ingress ?? "webhook");
  let appId: string;
  let appSecret: string;
  const verify = async (appId: string, appSecret: string) => {
    await opts.verifyCredentials(appId, appSecret);
    if (!reuseExistingApp) await opts.keep?.(appId, appSecret);
  };
  if (reuseExistingApp) {
    io.note(`Reusing Lark app ${existingId}.`);
    appId = required(existingId, "LARK_APP_ID", rerun);
    appSecret = required(existingSecret, "LARK_APP_SECRET", rerun);
    await verify(appId, appSecret);
  } else if (io.collect) {
    ({ appId, appSecret } = await io.collect({ consoleUrl, check: verify }));
  } else {
    io.openUrl(
      consoleUrl,
      "create the app on Lark's one-click launcher; LARK_APP_ID and LARK_APP_SECRET are under Credentials & Basic Info",
    );
    appId = required(
      await io.prompt("LARK_APP_ID (Credentials & Basic Info)", { hidden: false }),
      "LARK_APP_ID",
      rerun,
    );
    appSecret = required(
      await io.prompt("LARK_APP_SECRET (Credentials & Basic Info)", { hidden: true }),
      "LARK_APP_SECRET",
      rerun,
    );
    await verify(appId, appSecret);
  }

  const eventSecurityUrl = larkEventSecurityUrl(appId);
  io.note("App ID / Secret verified.");
  if (opts.ingress === "connection") {
    io.openUrl(
      eventSecurityUrl,
      "in Events & Callbacks, choose long connection and subscribe im.message.receive_v1, but do not publish yet: " +
        "the permission check follows (no Verification Token or Request URL is needed)",
    );
    return { LARK_APP_ID: appId, LARK_APP_SECRET: appSecret };
  }
  io.note("Trying automatic webhook-mode + Verification-Token bootstrap…");
  if (!opts.bootstrapWebhook) throw new Error("Lark webhook onboarding requires bootstrapWebhook");
  const bootstrap = await opts.bootstrapWebhook(appId, appSecret);
  if (bootstrap.token) {
    io.note("Verification Token captured; Subscription mode changed to webhook in the app draft.");
  } else {
    io.note(bootstrap.manualReason ?? "Automatic bootstrap unavailable.");
    io.openUrl(
      eventSecurityUrl,
      "in Events & Callbacks → Encryption Strategy, copy the Verification Token, and switch Subscription mode to " +
        "webhook when setting the Request URL",
    );
  }

  const verificationToken = required(
    bootstrap.token ||
      (reuseExistingApp ? opts.existing?.LARK_VERIFICATION_TOKEN?.trim() : undefined) ||
      (io.verificationToken
        ? await io.verificationToken(eventSecurityUrl)
        : await io.prompt("LARK_VERIFICATION_TOKEN (Events & Callbacks → Encryption Strategy)", { hidden: true })),
    "LARK_VERIFICATION_TOKEN",
    rerun,
  );

  return {
    LARK_APP_ID: appId,
    LARK_APP_SECRET: appSecret,
    LARK_VERIFICATION_TOKEN: verificationToken,
  };
}
