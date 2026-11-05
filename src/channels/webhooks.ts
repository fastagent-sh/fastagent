/**
 * A serve pointing its platforms at itself (SPEC.md §8, `Service.registerWebhooks`; channel-setup.md §5): which of its
 * channels take a webhook, the step a person takes for each one the instance cannot set, and the registration that
 * sets what the app's own credentials can set, on every call and without reading it first.
 */
import type { DeclaredChannel } from "./discover.ts";
import { registerFeishuWebhook } from "./feishu/register-webhook.ts";
import { DEPLOY_REGISTRATION_ATTEMPTS, type RegistrationOutcome } from "./registration.ts";
import { registerTelegramWebhook } from "./telegram/register-webhook.ts";

/** One webhook channel's registration (SPEC.md §8). */
export interface WebhookRegistration {
  /** The channel file's name. */
  channel: string;
  outcome: "pending" | RegistrationOutcome;
  /** The URL it was, or is to be, pointed at; absent when no base URL is known. */
  url?: string;
  /** For `manual` and `failed`: what to do, said as the step to take. */
  step?: string;
}

/** The first-party channels a webhook points at, in the order every report lists them. */
export type WebhookKind = "telegram" | "slack" | "feishu" | "lark";

const feishuCloud = (kind: "feishu" | "lark") => ({
  path: `/${kind}`,
  manual: (url: string) =>
    `${kind}: set the event Request URL in the developer console (Events & Callbacks) → ${url} (the app must be running when you save)`,
});

const KINDS: Record<WebhookKind, { path: string; manual: (url: string) => string }> = {
  telegram: {
    path: "/telegram",
    manual: (url) => `telegram: set the webhook → ${url} (secret_token = TELEGRAM_SECRET_TOKEN)`,
  },
  slack: { path: "/slack", manual: (url) => `slack: set Event Subscriptions → Request URL → ${url}` },
  feishu: feishuCloud("feishu"),
  lark: feishuCloud("lark"),
};

/** The first-party channels among `channels` that receive by webhook, in {@link KINDS}' order. */
export function webhookKinds(channels: readonly DeclaredChannel[]): WebhookKind[] {
  const declared = new Set(channels.filter((c) => c.ingress === "webhook").map((c) => c.name));
  return (Object.keys(KINDS) as WebhookKind[]).filter((kind) => declared.has(kind));
}

/** The channel's default route. */
export function webhookPath(kind: WebhookKind): string {
  return KINDS[kind].path;
}

/** The one line a person acts on to point `kind` at `baseUrl` by hand. */
export function manualWebhookStep(kind: WebhookKind, baseUrl: string): string {
  return KINDS[kind].manual(`${baseUrl}${KINDS[kind].path}`);
}

/** Every webhook channel, not registered yet: what a serve reports until its registration ends. */
export function pendingWebhooks(kinds: readonly WebhookKind[]): WebhookRegistration[] {
  return kinds.map((channel) => ({ channel, outcome: "pending" }));
}

/**
 * Point each of `kinds` at `<baseUrl>/<its path>` with the instance's own credentials (`env`): Telegram's `setWebhook`
 * and Feishu's or Lark's event-subscription PATCH, set on every call (Telegram's `getWebhookInfo` returns no
 * `secret_token`, and Feishu's route takes only a PATCH). Slack's Request URL is the app's configuration, which no
 * credential the instance holds can change: its outcome is `manual`. Without a base URL nothing is pointed.
 */
export async function registerOwnWebhooks(
  baseUrl: string | undefined,
  kinds: readonly WebhookKind[],
  env: NodeJS.ProcessEnv,
  options: { attempts?: number; retryMs?: number } = {},
): Promise<WebhookRegistration[]> {
  const registrations: WebhookRegistration[] = [];
  for (const kind of kinds) {
    if (baseUrl === undefined) {
      registrations.push({
        channel: kind,
        outcome: "manual",
        step: `${kind}: no http.publicUrl in the instance configuration, so nothing points the app at this instance`,
      });
      continue;
    }
    const url = `${baseUrl}${KINDS[kind].path}`;
    const step = KINDS[kind].manual(url);
    if (kind === "slack") {
      registrations.push({ channel: kind, outcome: "manual", url, step });
      continue;
    }
    const attempts = options.attempts ?? DEPLOY_REGISTRATION_ATTEMPTS;
    const retry = { attempts, ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }) };
    const outcome =
      kind === "telegram"
        ? await registerTelegramWebhook(baseUrl, { env, ...retry })
        : await registerFeishuWebhook(baseUrl, kind, { env, ...retry });
    registrations.push({ channel: kind, outcome, url, ...(outcome === "registered" ? {} : { step }) });
  }
  return registrations;
}
