/** HOW A RUNNING CHANNEL IS REACHED — the URL-neutral half of "point this channel at the agent". */
import type { DeclaredChannel } from "../channels/discover.ts";
import type { RegistrationOutcome } from "../channels/registration.ts";
import { type WebhookKind, manualWebhookStep, webhookKinds } from "../channels/webhooks.ts";

export interface Registrars {
  telegram: (baseUrl: string) => Promise<RegistrationOutcome>;
  feishu?: (baseUrl: string, kind: "feishu" | "lark") => Promise<RegistrationOutcome>;
}

/** How each kind is pointed at a URL; undefined when only a person can set it (Slack's Request URL is the app's page). */
const REGISTER: Record<
  WebhookKind,
  (registrars: Registrars, baseUrl: string) => Promise<RegistrationOutcome> | undefined
> = {
  telegram: (r, baseUrl) => r.telegram(baseUrl),
  slack: () => undefined,
  feishu: (r, baseUrl) => r.feishu?.(baseUrl, "feishu"),
  lark: (r, baseUrl) => r.feishu?.(baseUrl, "lark"),
};

/** Point every channel that has a webhook at `baseUrl`, reporting what each one ended as. */
export async function pointChannelsAt(input: {
  baseUrl: string;
  channels: readonly DeclaredChannel[];
  registrars: Registrars;
  log: (msg: string) => void;
}): Promise<{ kind: WebhookKind; outcome: RegistrationOutcome }[]> {
  const outcomes: { kind: WebhookKind; outcome: RegistrationOutcome }[] = [];
  for (const kind of webhookKinds(input.channels)) {
    // Calling IS the question: a channel whose registrar the caller did not wire returns undefined.
    const running = REGISTER[kind](input.registrars, input.baseUrl);
    if (!running) {
      input.log(manualWebhookStep(kind, input.baseUrl));
      outcomes.push({ kind, outcome: "manual" }); // a human's step — re-surfaced after registrar output
      continue;
    }
    input.log(`registering ${kind} webhook…`);
    outcomes.push({ kind, outcome: await running });
  }
  return outcomes;
}
