/** HOW A RUNNING CHANNEL IS REACHED — the URL-neutral half of "point this channel at the agent". */
import type { DeclaredChannel } from "../channels/discover.ts";
import type { RegistrationOutcome } from "../channels/registration.ts";
import {
  type WebhookKind,
  type WebhookRegistration,
  manualWebhookStep,
  webhookKinds,
  webhookPath,
} from "../channels/webhooks.ts";
import { registrationGate } from "./registration-gate.ts";
import { waitForHealth } from "../channels/wait-health.ts";

export interface Registrars {
  telegram: (baseUrl: string) => Promise<RegistrationOutcome>;
  feishu?: (baseUrl: string, kind: "feishu" | "lark") => Promise<RegistrationOutcome>;
  /**
   * Where a channel's manual step goes beside the log, for a person who reads no log: a coding agent's user, through
   * the deploy's ticket (its `afterwards`).
   */
  leave?: (step: string) => void;
}

interface ChannelIngress {
  /** Runs this channel's registration end-to-end, or undefined when the caller wired no registrar for it. */
  register: (registrars: Registrars, baseUrl: string) => Promise<RegistrationOutcome> | undefined;
  /** The runbook block for a plan, which cannot register anything (comment lines + commands). */
  runbook: (baseUrl: string) => string[];
  /** When the selected app starts delivering to this deployment. */
  delivers: string;
}

const feishuCloud = (kind: "feishu" | "lark", label: string): ChannelIngress => ({
  // The subscription mode is the published version's: a switch from long connection waits for the publish.
  delivers:
    "delivers to this deployment once its published version is in webhook mode (after a first deploy, publish the " +
    "version it opened)",
  register: (r, baseUrl) => r.feishu?.(baseUrl, kind),
  runbook: (baseUrl) => [
    `# Set the ${label} event Request URL (developer console → Events & Callbacks). Default route`,
    `# POST /${kind}; the app must be RUNNING when you save (the console verifies with a challenge):`,
    `#   Request URL = ${baseUrl}/${kind}`,
  ],
});

/** Declaration order — the order every runbook and every driver reports in. */
const INGRESS: Record<WebhookKind, ChannelIngress> = {
  telegram: {
    delivers: "now delivers to this deployment",
    register: (r, baseUrl) => r.telegram(baseUrl),
    runbook: (baseUrl) => [
      `# Register the Telegram webhook. The path assumes the default route (POST /telegram); if you`,
      `# remapped it in channels/telegram.ts, use your path. secret_token MUST equal TELEGRAM_SECRET_TOKEN:`,
      `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \\`,
      `  -d url=${baseUrl}/telegram -d secret_token=<TELEGRAM_SECRET_TOKEN>`,
    ],
  },
  slack: {
    delivers: "now delivers to this deployment",
    // The Request URL is the app's page, which a person sets (channel-setup.md §3): no credential here changes it.
    register: () => undefined,
    runbook: (baseUrl) => [
      `# Set Slack Event Subscriptions → Request URL (default route POST /slack; the running service`,
      `# answers Slack's challenge), and match scopes/subscriptions to the app \`channels setup slack\` created:`,
      `#   Request URL = ${baseUrl}/slack`,
    ],
  },
  feishu: feishuCloud("feishu", "Feishu"),
  lark: feishuCloud("lark", "Lark"),
};

/** Default route keys for {@link webhookKinds}, in the same order (the docker plan's ingress note). */
export function webhookPaths(channels: readonly DeclaredChannel[]): string[] {
  return webhookKinds(channels).map(webhookPath);
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
}): Promise<{ kind: WebhookKind; outcome: RegistrationOutcome }[]> {
  const outcomes: { kind: WebhookKind; outcome: RegistrationOutcome }[] = [];
  for (const kind of webhookKinds(input.channels)) {
    const ingress = INGRESS[kind];
    // Calling IS the question: a channel whose registrar the caller did not wire returns undefined.
    const running = ingress.register(input.registrars, input.baseUrl);
    if (!running) {
      input.log(manualWebhookStep(kind, input.baseUrl));
      outcomes.push({ kind, outcome: "manual" }); // a human's step — re-surfaced after registrar output
      continue;
    }
    input.log(`registering ${kind} webhook…`);
    outcomes.push({ kind, outcome: await running });
  }
  // What the registrar said is in the log; the person who reads none gets the one route to set.
  for (const { kind } of outcomes.filter(({ outcome }) => outcome === "manual")) {
    input.registrars.leave?.(manualWebhookStep(kind, input.baseUrl));
  }
  return outcomes;
}

/**
 * How long a just-deployed public URL gets to answer `/health`: the boot publishes the definition onto the volume
 * before it binds a port, so this budget covers a copy on slow host storage, not a listen.
 */
const PUBLIC_HEALTH_TIMEOUT_MS = 180_000;

/** How often the wait announces itself, so a crash-looping app is not three silent minutes. */
const WAIT_NOTICE_MS = 15_000;

/** Poll a public `/health` until it answers 200; false on timeout. Injected by tests. */
export type PublicHealthProbe = (healthUrl: string) => Promise<boolean>;

/**
 * The readiness floor a host clears BEFORE {@link registerWebhooks}: `setWebhook` does not verify that anything
 * answers the URL, so a deploy whose app crash-loops would otherwise point a live channel at a dead address and
 * report success. The channels that DO verify (Slack/Feishu challenge) would fail here too, but as "registration
 * failed" — a diagnosis that hides the actual cause.
 *
 * Asked ONLY when this deployment actually has a webhook to point, or a login on the box follows (the box must
 * have prepared its storage and installed the CLI the login runs). A definition with neither (schedules only, the
 * built-in `POST /invoke`, or long-connection channels) needs no inbound reachability at all, and demanding it would
 * invent a failure for a deploy run from a network that cannot reach the platform's edge.
 */
export async function publicHealthGate(input: {
  baseUrl: string;
  channels: readonly DeclaredChannel[];
  log: (msg: string) => void;
  /** How THIS host is inspected and re-run — the only per-host words in the gate. */
  inspectHint: string;
  probe?: PublicHealthProbe;
  /** The login that follows on the box (`fastagent login --deployment <host>`), when one does. */
  login?: string;
}): Promise<string | undefined> {
  if (webhookKinds(input.channels).length === 0 && input.login === undefined) return undefined;
  const healthUrl = `${input.baseUrl}/health`;
  input.log(`waiting for ${healthUrl} (up to ${PUBLIC_HEALTH_TIMEOUT_MS / 1000}s)…`);
  const probe =
    input.probe ?? ((url: string) => waitForHealth(url, PUBLIC_HEALTH_TIMEOUT_MS, 500, announce(input.log)));
  if (await probe(healthUrl)) return undefined;
  // The infrastructure is up and only activation is missing, so hand over the manual route rather than leaving
  // `re-run` as the only way out (a Fly re-run repeats the remote build). The login comes first: a channel pointed at
  // a box with no model credential fails every message.
  const steps = [
    ...(input.login !== undefined ? [`# First, log the box in: ${input.login}`] : []),
    ...webhookRunbook(input.baseUrl, input.channels),
  ];
  for (const line of steps) input.log(line);
  const byHand =
    webhookKinds(input.channels).length > 0
      ? `To finish by hand once it answers, use the lines above.`
      : `Once it answers, log it in: ${input.login}.`;
  return (
    `the deployed agent did not become healthy at ${healthUrl}, so it was not activated — ${input.inspectHint}. ` +
    byHand
  );
}

/**
 * The gate when the login on the box did not happen. It stops the run BEFORE registration (a channel pointed at a box
 * with no model credential fails every message), so the login it asks for does not register anything by itself: with
 * a webhook to point, the refusal says what comes after the login, and prints the lines to do it by hand when the
 * URL is known.
 */
export function loginGate(input: {
  /** What the login reported, ending with the command to run. */
  notLoggedIn: string;
  channels: readonly DeclaredChannel[];
  log: (msg: string) => void;
  /** What THIS host does about its webhooks once the box is logged in — the only per-host words in the gate. */
  afterLogin: string;
  /** Where the channels point, for the lines that point them by hand; unset when the host has none to print. */
  baseUrl?: string;
}): string {
  if (webhookKinds(input.channels).length === 0) return input.notLoggedIn;
  const byHand = input.baseUrl === undefined ? [] : webhookRunbook(input.baseUrl, input.channels);
  for (const line of byHand) input.log(line);
  // "Confirmed none" is about THIS run only: a channel the box or an earlier deploy pointed here still delivers.
  return (
    `${input.notLoggedIn}. This deploy confirmed no webhook, and logging in confirms none; any already pointed here, ` +
    `by the box itself or by an earlier deploy, still delivers, and every message it brings fails until the box is ` +
    `logged in. Once it is, ` +
    `${input.afterLogin}` +
    (byHand.length > 0 ? `. The lines above point the channels by hand.` : ``)
  );
}

/**
 * Keep the wait visible. This occupies `waitForHealth`'s liveness slot without answering it: neither Fly nor Railway
 * has a liveness question cheaper than the wait it would shorten (each is a CLI round trip, unlike docker's local
 * `compose ps`), so the hook reports progress and never cuts the budget short.
 */
function announce(log: (msg: string) => void): () => Promise<boolean> {
  const started = Date.now();
  let last = started;
  return async () => {
    const now = Date.now();
    if (now - last >= WAIT_NOTICE_MS) {
      last = now;
      log(`still waiting for /health (${Math.round((now - started) / 1000)}s)…`);
    }
    return true;
  };
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
  const outcomes = await pointChannelsAt(input);
  for (const { kind, outcome } of outcomes) reg.track(kind, outcome);
  for (const { kind } of outcomes.filter(({ outcome }) => outcome === "registered")) {
    input.log(`the selected production ${kind} app ${INGRESS[kind].delivers}`);
  }
  return reg.gate();
}

/** How long a deploy waits for a box to end its own registration: the box's registrars retry for about 190 s. */
const BOX_REGISTRATION_TIMEOUT_MS = 240_000;

/** A box's `/health` webhooks, or undefined while it cannot be read. Injected by tests. */
export type BoxWebhooksProbe = (
  healthUrl: string,
) => Promise<readonly { channel: string; outcome: WebhookRegistration["outcome"] }[] | undefined>;

const readBoxWebhooks: BoxWebhooksProbe = async (healthUrl) => {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { webhooks?: unknown };
    return Array.isArray(body.webhooks)
      ? (body.webhooks as { channel: string; outcome: RegistrationOutcome }[])
      : undefined;
  } catch {
    return undefined; // not routable, or not answering JSON yet: polled again until the deadline
  }
};

/**
 * What a box that points its own channels made of them (channel-setup.md §5): read from its `/health` until no channel
 * is `pending`, then gated as {@link registerWebhooks} gates. Slack's Request URL no credential on the box can set, so
 * `registrars.slack` sets it from this machine, as before.
 */
export async function confirmWebhooks(input: {
  /** Where this machine reaches the box's `/health`: the host's own URL. */
  baseUrl: string;
  /** Where the platforms reach it, the delivered `http.publicUrl` (a custom domain, say): every step names this one. */
  publicUrl: string;
  channels: readonly DeclaredChannel[];
  registrars: Pick<Registrars, "leave">;
  log: (msg: string) => void;
  retryHint: string;
  probe?: BoxWebhooksProbe;
  timeoutMs?: number;
  intervalMs?: number;
  /** At a terminal with a `--config` file: record each URL a person set once the box confirms it. */
  record?: UrlRecorder;
}): Promise<string | undefined> {
  const kinds = webhookKinds(input.channels);
  const reg = registrationGate(input.log, input.retryHint);
  const outcomes = new Map<WebhookKind, RegistrationOutcome>();
  if (kinds.includes("slack")) {
    input.log(manualWebhookStep("slack", input.publicUrl));
    outcomes.set("slack", "manual");
  }
  const own = kinds.filter((kind) => kind !== "slack");
  if (own.length > 0) {
    input.log(`waiting for the box to point ${own.join(", ")} at ${input.publicUrl}…`);
    const probe = input.probe ?? readBoxWebhooks;
    const deadline = Date.now() + (input.timeoutMs ?? BOX_REGISTRATION_TIMEOUT_MS);
    for (;;) {
      const read = await probe(`${input.baseUrl}/health`);
      const ended = own.map((kind) => read?.find((entry) => entry.channel === kind));
      if (ended.every((entry) => entry !== undefined && entry.outcome !== "pending")) {
        for (const [i, kind] of own.entries()) outcomes.set(kind, ended[i]?.outcome as RegistrationOutcome);
        break;
      }
      if (Date.now() >= deadline) {
        for (const [i, kind] of own.entries()) {
          if (ended[i] === undefined || ended[i]?.outcome === "pending") {
            input.log(`${kind}: the box did not report its registration within the wait — see its log`);
            outcomes.set(kind, "failed");
          } else {
            outcomes.set(kind, ended[i]?.outcome as RegistrationOutcome);
          }
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, input.intervalMs ?? 2_000));
    }
  }
  for (const kind of kinds) {
    if (outcomes.get(kind) === "registered" || kind === "slack") continue;
    // What the box said and why is in its log; the line a person acts on is said here.
    input.log(manualWebhookStep(kind, input.publicUrl));
    input.registrars.leave?.(manualWebhookStep(kind, input.publicUrl));
  }
  if (input.record !== undefined) await recordConfirmed(input, kinds, outcomes, input.record);
  for (const kind of kinds) {
    const outcome = outcomes.get(kind) as RegistrationOutcome;
    reg.track(kind, outcome);
    if (outcome === "registered") input.log(`the selected production ${kind} app ${INGRESS[kind].delivers}`);
  }
  return reg.gate();
}

/** Where a deploy at a terminal records the URL a person set once the box confirms it (`channels.<name>.app.url`). */
export interface UrlRecorder {
  /** How long to wait for the person to save the URL on the app's page. */
  waitMs: number;
  /** Write `url` into the binding of `kind` in the configuration `--config` names; resolves where it wrote. */
  write(kind: WebhookKind, url: string): Promise<string>;
}

/**
 * For each channel whose URL only a person sets (Slack; Lark without its config API), wait for the box to report it
 * reached at the delivered URL, then record that URL in the binding, so every later deploy, CI included, reports it
 * `registered` from the start (channel-setup.md §5).
 */
async function recordConfirmed(
  input: {
    publicUrl: string;
    log: (msg: string) => void;
    probe?: BoxWebhooksProbe;
    baseUrl: string;
    intervalMs?: number;
  },
  kinds: readonly WebhookKind[],
  outcomes: Map<WebhookKind, RegistrationOutcome>,
  record: UrlRecorder,
): Promise<void> {
  const probe = input.probe ?? readBoxWebhooks;
  const waiting = new Set(kinds.filter((k) => (k === "slack" || k === "lark") && outcomes.get(k) !== "failed"));
  if (waiting.size === 0) return;
  const later = (kind: WebhookKind) => `\`fastagent channels setup ${kind} --config <file> --record-url\``;
  const manual = [...waiting].filter((kind) => outcomes.get(kind) === "manual");
  if (manual.length > 0) {
    input.log(
      `waiting up to ${Math.round(record.waitMs / 60_000)} min for ` +
        `${manual.map((kind) => `${input.publicUrl}${webhookPath(kind)}`).join(" and ")} to be saved on the app's ` +
        `page (the platform verifies it with this box); stop it any time and record it later with ${later(manual[0] as WebhookKind)}`,
    );
  }
  // One deadline for every channel still waiting: each is recorded as the box reports it reached.
  const deadline = Date.now() + record.waitMs;
  for (;;) {
    const read = await probe(`${input.baseUrl}/health`);
    for (const kind of [...waiting]) {
      if (read?.find((entry) => entry.channel === kind)?.outcome !== "registered") continue;
      waiting.delete(kind);
      outcomes.set(kind, "registered");
      const url = `${input.publicUrl}${webhookPath(kind)}`;
      // The deployment is done and the platform reaches it: a record not written is said, never the deploy's failure.
      await record.write(kind, url).then(
        (where) => input.log(`${kind}: the platform reached the box at ${url}; recorded it in ${where}`),
        (error: unknown) =>
          input.log(
            `${kind}: the platform reached the box at ${url}, but it was not recorded (${(error as Error).message}); ` +
              `record it with ${later(kind)}`,
          ),
      );
    }
    if (waiting.size === 0 || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs ?? 2_000));
  }
}
