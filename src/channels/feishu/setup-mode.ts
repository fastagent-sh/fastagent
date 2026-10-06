/** Feishu/Lark app-level event subscription choice used by onboarding and scaffolding. */
export type FeishuSubscriptionMode = "webhook" | "websocket";

/**
 * Configuring THIS app through the v7 config API: registering a webhook Request URL and switching the subscription
 * mode. Requested for a webhook app only. A tenant may review it, and a scope under review holds the app's whole first
 * version in review, so a WebSocket app, which never uses it, would wait on an admin for nothing (measured: the same
 * creation without it came back active).
 */
export const FEISHU_APP_CONFIG_SCOPE = "application:application:patch";

/** The one event an agent app cannot serve without: an inbound message. */
export const FEISHU_MESSAGE_RECEIVE_EVENT = "im.message.receive_v1";

/** A scope the onboarding asks for, plus any BROADER spelling that already satisfies it. */
export interface FeishuScopeRequest {
  /** What to request when nothing satisfies it. */
  request: string;
  /** EXTRA spellings that also count — supersets. */
  supersets?: string[];
  /** What the agent loses without it, for the warning that names it. */
  withoutIt: string;
}

/** Whether `predicate` holds for any spelling that satisfies this request. */
export function scopeSatisfied(entry: FeishuScopeRequest, predicate: (name: string) => boolean): boolean {
  return [entry.request, ...(entry.supersets ?? [])].some(predicate);
}

/**
 * What an agent may know about the rooms it is in, on top of the platform's agent template. There is one posture: the
 * agent takes part in its rooms like a colleague (participant-model.md), so every app gets all of it, requested at
 * creation in the one round a tenant may want to approve. What a scope is for is the agent's, not only the channel's:
 * the agent can call the Open API with the app's credentials. A scope belongs here only once something uses it:
 * `im:message.group_msg.include_bot:read` (other bots' group messages) is an event-delivery scope, and the channel
 * drops every non-user sender, so it waits for the channel to read bot messages.
 */
export const FEISHU_AGENT_SCOPES: FeishuScopeRequest[] = [
  {
    request: "im:message.group_msg", // sensitive: some tenants approve it by hand
    withoutIt: "only @mentions arrive: no bare replies in the agent's threads, no group discussion as context",
  },
  {
    request: "im:message:readonly",
    supersets: ["im:message"], // the read/write superset
    withoutIt: "a message quoted by an ask cannot be read and degrades to a marker in the prompt",
  },
  {
    request: "im:chat.members:read",
    withoutIt: "the agent cannot list a chat's members by name (events carry only open_ids)",
  },
];

/**
 * What a created app carries on top of the platform's agent template — the `addons` merged onto the confirm page. A
 * scope that arrives here needs no console visit; one a tenant withholds is reported after creation (`add-feishu.ts`).
 */
export function feishuAppAddons(ingress: FeishuSubscriptionMode): {
  scopes: { tenant: string[] };
  events: { items: { tenant: string[] } };
} {
  const config = ingress === "webhook" ? [FEISHU_APP_CONFIG_SCOPE] : [];
  return {
    scopes: { tenant: [...config, ...FEISHU_AGENT_SCOPES.map((entry) => entry.request)] },
    events: { items: { tenant: [FEISHU_MESSAGE_RECEIVE_EVENT] } },
  };
}

/** The console page that requests `scopes` for this app, pre-filled: the platform's own link for a missing scope. */
export function feishuScopeRequestUrl(apiBase: string, appId: string, scopes: readonly string[]): string {
  const url = new URL(`${apiBase}/app/${encodeURIComponent(appId)}/auth`);
  url.searchParams.set("q", scopes.join(","));
  url.searchParams.set("op_from", "openapi");
  url.searchParams.set("token_type", "tenant");
  return url.toString();
}
