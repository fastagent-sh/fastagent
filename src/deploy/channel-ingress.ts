/** HOW A RUNNING CHANNEL IS REACHED — the URL-neutral half of "point this channel at the agent". */
import type { DeclaredChannel } from "../channels/discover.ts";
import type { RegistrationOutcome } from "../channels/registration.ts";
import type { ChannelKind } from "../scaffold/add-channel.ts";
import { registrationGate } from "./registration-gate.ts";

export interface Registrars {
  telegram: (baseUrl: string) => Promise<RegistrationOutcome>;
  slack?: (baseUrl: string) => Promise<RegistrationOutcome>;
  feishu?: (baseUrl: string, kind: "feishu" | "lark") => Promise<RegistrationOutcome>;
}

interface ChannelIngress {
  /** The channel's DEFAULT route key. */
  path: string;
  /**
   * Runs this channel's registration end-to-end, or undefined when the caller wired no registrar for it. github never
   * has one.
   */
  register?: (registrars: Registrars, baseUrl: string) => Promise<RegistrationOutcome> | undefined;
  /** The one line a driver prints when no registrar runs it. */
  manual: (baseUrl: string) => string;
  /** The runbook block for a plan, which cannot register anything (comment lines + commands). */
  runbook: (baseUrl: string) => string[];
}

const feishuCloud = (kind: "feishu" | "lark", label: string): ChannelIngress => ({
  path: `/${kind}`,
  register: (r, baseUrl) => r.feishu?.(baseUrl, kind),
  manual: (baseUrl) =>
    `${kind}: set the event Request URL in the developer console (Events & Callbacks) → ${baseUrl}/${kind} (the app must be running when you save)`,
  runbook: (baseUrl) => [
    `# Set the ${label} event Request URL (developer console → Events & Callbacks). Default route`,
    `# POST /${kind}; the app must be RUNNING when you save (the console verifies with a challenge):`,
    `#   Request URL = ${baseUrl}/${kind}`,
  ],
});

/** Declaration order — the order every runbook and every driver reports in. */
const INGRESS: Record<ChannelKind, ChannelIngress> = {
  telegram: {
    path: "/telegram",
    register: (r, baseUrl) => r.telegram(baseUrl),
    manual: (baseUrl) => `telegram: set the webhook → ${baseUrl}/telegram (secret_token = TELEGRAM_SECRET_TOKEN)`,
    runbook: (baseUrl) => [
      `# Register the Telegram webhook. The path assumes the default route (POST /telegram); if you`,
      `# remapped it in channels/telegram.ts, use your path. secret_token MUST equal TELEGRAM_SECRET_TOKEN:`,
      `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \\`,
      `  -d url=${baseUrl}/telegram -d secret_token=<TELEGRAM_SECRET_TOKEN>`,
    ],
  },
  github: {
    path: "/webhook",
    // The env-var name is the part a first-time operator cannot guess, and this line is all `--tunnel` prints — there
    // is no runbook beside it to carry the detail.
    manual: (baseUrl) =>
      `github: set the webhook in the repo (Settings → Webhooks) → ${baseUrl}/webhook (content type application/json, secret = GITHUB_WEBHOOK_SECRET)`,
    runbook: (baseUrl) => [
      `# Set the GitHub webhook (repo Settings → Webhooks). Default route POST /webhook; if you remapped`,
      `# it in channels/github.ts, use your path:`,
      `#   Payload URL = ${baseUrl}/webhook, content type application/json, secret = GITHUB_WEBHOOK_SECRET`,
    ],
  },
  slack: {
    path: "/slack",
    register: (r, baseUrl) => r.slack?.(baseUrl),
    manual: (baseUrl) => `slack: set Event Subscriptions → Request URL → ${baseUrl}/slack`,
    runbook: (baseUrl) => [
      `# Set Slack Event Subscriptions → Request URL (default route POST /slack; the running service`,
      `# answers Slack's challenge), and match scopes/subscriptions to the app \`add slack --group-behavior\` created:`,
      `#   Request URL = ${baseUrl}/slack`,
    ],
  },
  feishu: feishuCloud("feishu", "Feishu"),
  lark: feishuCloud("lark", "Lark"),
};

/**
 * The first-party channels this deployment must point at a URL: webhook ingress, and a kind this tool knows how to
 * instruct.
 */
export function webhookKinds(channels: readonly DeclaredChannel[]): ChannelKind[] {
  const declared = new Set(channels.filter((c) => c.ingress === "webhook").map((c) => c.name));
  return (Object.keys(INGRESS) as ChannelKind[]).filter((kind) => declared.has(kind));
}

/** Default route keys for {@link webhookKinds}, in the same order (the docker plan's ingress note). */
export function webhookPaths(channels: readonly DeclaredChannel[]): string[] {
  return webhookKinds(channels).map((kind) => INGRESS[kind].path);
}

/**
 * The runbook block for every channel that needs a URL set by hand, `baseUrl` spelled the host's way (a literal
 * `https://app.fly.dev`, or a placeholder like `<your-domain>` the operator fills in).
 */
export function webhookRunbook(baseUrl: string, channels: readonly DeclaredChannel[]): string[] {
  return webhookKinds(channels).flatMap((kind) => INGRESS[kind].runbook(baseUrl));
}

/** Point every channel that has a webhook at `baseUrl`, reporting what each one ended as. */
export async function pointChannelsAt(input: {
  baseUrl: string;
  channels: readonly DeclaredChannel[];
  registrars: Registrars;
  log: (msg: string) => void;
}): Promise<{ kind: ChannelKind; outcome: RegistrationOutcome }[]> {
  const outcomes: { kind: ChannelKind; outcome: RegistrationOutcome }[] = [];
  for (const kind of webhookKinds(input.channels)) {
    const ingress = INGRESS[kind];
    // Calling IS the question: a channel whose registrar the caller did not wire returns undefined.
    const running = ingress.register?.(input.registrars, input.baseUrl);
    if (!running) {
      input.log(ingress.manual(input.baseUrl));
      outcomes.push({ kind, outcome: "manual" }); // a human's step — re-surfaced after registrar output
      continue;
    }
    input.log(`registering ${kind} webhook…`);
    outcomes.push({ kind, outcome: await running });
  }
  return outcomes;
}

/** {@link pointChannelsAt} plus the shared gate policy, for a command that EXITS. */
export async function registerWebhooks(input: {
  baseUrl: string;
  channels: readonly DeclaredChannel[];
  registrars: Registrars;
  log: (msg: string) => void;
  /** How THIS host retries — the only per-host words in the gate. */
  retryHint: string;
}): Promise<string | undefined> {
  const reg = registrationGate(input.log, input.retryHint);
  for (const { kind, outcome } of await pointChannelsAt(input)) reg.track(kind, outcome);
  return reg.gate();
}
