import type { RegistrationOutcome } from "../src/channels/registration.ts";
import type { BoxWebhooksProbe } from "../src/deploy/channel-ingress.ts";

/**
 * A deployed box's `/health`, reporting each webhook channel as `registrars` would have registered it at the URL the
 * box serves: what a host run reads once the box points its own channels.
 */
export function boxReporting(registrars: {
  telegram?: (baseUrl: string) => Promise<RegistrationOutcome>;
  feishu?: (baseUrl: string, kind: "feishu" | "lark") => Promise<RegistrationOutcome>;
}): { probe: BoxWebhooksProbe; intervalMs: number } {
  return {
    intervalMs: 0,
    probe: async (healthUrl) => {
      const baseUrl = healthUrl.replace(/\/health$/, "");
      const entries: { channel: string; outcome: RegistrationOutcome }[] = [];
      if (registrars.telegram) entries.push({ channel: "telegram", outcome: await registrars.telegram(baseUrl) });
      if (registrars.feishu) entries.push({ channel: "feishu", outcome: await registrars.feishu(baseUrl, "feishu") });
      return entries;
    },
  };
}
