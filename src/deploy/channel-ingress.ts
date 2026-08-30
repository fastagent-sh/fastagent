/**
 * HOW A DEPLOYED CHANNEL IS REACHED — the host-neutral half of "point this channel at the running
 * agent": its default route, whether anything can set that URL end-to-end, and the words an operator
 * needs when nothing can. Only the base URL is the host's to know (`<app>.fly.dev`, a minted Railway
 * domain, a Function URL), which is the argument every function here takes.
 *
 * It exists because that knowledge belongs to the CHANNEL and was written per HOST: three runbook
 * plans, three `--run` drivers, a path table in the docker plan and the `--tunnel` announcer each
 * hand-wrote the same five-branch if-chain. A rule spelled seven times drifts, and it did — the
 * long-connection exception reached only the feishu/lark branches, so a long-connection Telegram
 * deploy printed `setWebhook` in its runbook, which makes `getUpdates` return 409 and stops the
 * channel the operator just deployed.
 *
 * Every function here takes the {@link DeclaredChannel} list and filters it ITSELF. Taking a
 * pre-filtered list would put the rule back at the call sites, which is where it drifted from: the
 * `--tunnel` announcer trusted its caller that way and had a default that passed every channel,
 * long-connection ones included.
 *
 * A host adds its base URL and its own asides; it does not restate which channels have a webhook.
 */
import type { DeclaredChannel } from "../channels/discover.ts";
import type { RegistrationOutcome } from "../channels/registration.ts";
import type { ChannelKind } from "../scaffold/add-channel.ts";
import { registrationGate } from "./registration-gate.ts";

/** The registrars a host can drive. `telegram` is always available (fastagent holds the token and the
 *  URL); the others are optional so a caller without their credentials falls back to a manual step. */
export interface Registrars {
  telegram: (baseUrl: string) => Promise<RegistrationOutcome>;
  slack?: (baseUrl: string) => Promise<RegistrationOutcome>;
  feishu?: (baseUrl: string, kind: "feishu" | "lark") => Promise<RegistrationOutcome>;
}

interface ChannelIngress {
  /** The channel's DEFAULT route key. Reading the real one would mean executing the channel factory
   *  (getMe, state-dir creation) — wrong at plan time — so every message states the assumption. */
  path: string;
  /** Runs this channel's registration end-to-end, or undefined when the caller wired no registrar for
   *  it. github never has one: it is a repo settings screen only a human can reach. */
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
    manual: (baseUrl) => `github: set the webhook in the repo (Settings → Webhooks) → ${baseUrl}/webhook`,
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
      `# answers Slack's challenge), and match scopes/subscriptions to channels/slack.ts groupBehavior:`,
      `#   Request URL = ${baseUrl}/slack`,
    ],
  },
  feishu: feishuCloud("feishu", "Feishu"),
  lark: feishuCloud("lark", "Lark"),
};

/**
 * The first-party channels this deployment must point at a URL: webhook ingress, and a kind this tool
 * knows how to instruct. ONE answer for every host and every path — the runbooks, the `--run`
 * drivers, the docker ingress note, `--tunnel`. A custom channel is skipped here and reported by the
 * pre-flight instead: its URL is its author's to set.
 */
export function webhookKinds(channels: readonly DeclaredChannel[]): ChannelKind[] {
  const declared = new Set(channels.filter((c) => c.ingress === "webhook").map((c) => c.name));
  return (Object.keys(INGRESS) as ChannelKind[]).filter((kind) => declared.has(kind));
}

/** Default route keys for {@link webhookKinds}, in the same order (the docker plan's ingress note). */
export function webhookPaths(channels: readonly DeclaredChannel[]): string[] {
  return webhookKinds(channels).map((kind) => INGRESS[kind].path);
}

/** The runbook block for every channel that needs a URL set by hand, `baseUrl` spelled the host's way
 *  (a literal `https://app.fly.dev`, or a placeholder like `<your-domain>` the operator fills in). */
export function webhookRunbook(baseUrl: string, channels: readonly DeclaredChannel[]): string[] {
  return webhookKinds(channels).flatMap((kind) => INGRESS[kind].runbook(baseUrl));
}

/**
 * Point every channel that has a webhook at `baseUrl`, reporting what each one ended as. All channels
 * are attempted — one failure does not skip the rest — and a channel whose registrar the caller did
 * not wire reports `manual` with the operator's instruction. The two callers differ in what they do
 * with the outcomes, not in how they are produced: a deploy gates on them, a long-running serve
 * cannot ({@link registerWebhooks} is the gating half).
 */
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

/**
 * {@link pointChannelsAt} plus the shared gate policy, for a command that EXITS: an exit 0 claims the
 * deployment is reachable, so a failed registration has to become a non-zero one. Returns the gate
 * message, or undefined when nothing gates.
 */
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
