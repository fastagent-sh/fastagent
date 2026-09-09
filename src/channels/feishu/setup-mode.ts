/** Feishu/Lark app-level event subscription choice used by onboarding and scaffolding. */
export type FeishuSubscriptionMode = "webhook" | "websocket";

/** Onboarding choice for group visibility. */
export type FeishuGroupBehavior = "context" | "mentions";

/**
 * Configuring THIS app: what every v7 config PATCH needs — registering a webhook Request URL, and adding a scope to
 * the app draft during context-aware group setup.
 */
export const FEISHU_APP_CONFIG_SCOPE = "application:application:patch";

/** The one event an agent app cannot serve without: an inbound message. */
export const FEISHU_MESSAGE_RECEIVE_EVENT = "im.message.receive_v1";

/**
 * What a created app carries on top of the platform's agent template, for EITHER ingress — the `addons` merged onto
 * the confirm page.
 */
export function feishuAppAddons(): {
  scopes: { tenant: string[] };
  events: { items: { tenant: string[] } };
} {
  return {
    scopes: { tenant: [FEISHU_APP_CONFIG_SCOPE] },
    events: { items: { tenant: [FEISHU_MESSAGE_RECEIVE_EVENT] } },
  };
}

/** The sensitive tenant scope behind both bare replies in the agent's threads and group context buffering. */
export const FEISHU_GROUP_CONTEXT_SCOPE = "im:message.group_msg";

/** Reading a QUOTED message by id, so an ask carries what it replies to (participant-model.md §8). */
export const FEISHU_MESSAGE_READ_SCOPE = "im:message:readonly";

/** A scope the onboarding asks for, plus any BROADER spelling that already satisfies it. */
export interface FeishuScopeRequest {
  /** What to add to the app draft when nothing satisfies it. */
  request: string;
  /** EXTRA spellings that also count — supersets. */
  supersets?: string[];
}

/** Whether `predicate` holds for any spelling that satisfies this request. */
export function scopeSatisfied(entry: FeishuScopeRequest, predicate: (name: string) => boolean): boolean {
  return [entry.request, ...(entry.supersets ?? [])].some(predicate);
}

/** Reading a quoted message: `im:message` is the read/write superset, so an app holding it can already do so. */
export const FEISHU_MESSAGE_READ_REQUEST: FeishuScopeRequest = {
  request: FEISHU_MESSAGE_READ_SCOPE,
  supersets: ["im:message"],
};

/** What `--group-behavior context` REQUESTS in one approval round — not a dependency set. */
export const FEISHU_CONTEXT_ONBOARDING_SCOPES: FeishuScopeRequest[] = [
  { request: FEISHU_GROUP_CONTEXT_SCOPE },
  FEISHU_MESSAGE_READ_REQUEST,
];
