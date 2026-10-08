import { servedByDev } from "../../serving-command.ts";
import { type FeishuCloudKind, cloudFor } from "./cloud.ts";

/** Feishu/Lark app-level event subscription choice: how a channel receives, and what an app is set up for. */
export type FeishuSubscriptionMode = "webhook" | "websocket";

/** The settings {@link feishuIngressFor} reads, one per cloud: what `deploy` must read the way the box will. */
export const FEISHU_INGRESS_SETTINGS = (["feishu", "lark"] as const).map(
  (kind) => `${cloudFor(kind).envPrefix}_INGRESS`,
);

/**
 * How THIS process receives a Feishu/Lark channel (docs/design/channel-environments.md): `<PREFIX>_INGRESS` when the
 * environment names one, else WebSocket under `dev` (no public URL, no reviewed scope) and webhook everywhere else,
 * which is what every deployment runs. The channel file asks at import, and so does every reader of its shape: `deploy`
 * inspects it in a process that is not `dev`, with the same value file loaded, so it sees what the box will serve.
 */
export function feishuIngressFor(kind: FeishuCloudKind, env: NodeJS.ProcessEnv = process.env): FeishuSubscriptionMode {
  const name = `${cloudFor(kind).envPrefix}_INGRESS`;
  const raw = env[name]?.trim();
  if (!raw) return servedByDev(env) ? "websocket" : "webhook";
  if (raw !== "webhook" && raw !== "websocket") {
    throw new Error(`${name} must be "webhook" or "websocket", got "${raw}"`);
  }
  return raw;
}

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
 * `im:message.group_msg.include_bot:read` (other bots' group messages) is an event-delivery scope. The channel reads
 * other bots' messages from a chat's history, which does not need it (measured), and drops every non-user event.
 */
export const FEISHU_AGENT_SCOPES: FeishuScopeRequest[] = [
  {
    request: "im:message.group_msg", // sensitive: some tenants approve it by hand
    withoutIt: "only @mentions arrive: no bare replies in the agent's threads, no group discussion as context",
  },
  {
    request: "im:message:readonly",
    supersets: ["im:message"], // the read/write superset
    withoutIt:
      "the discussion before an ask cannot be read (the prompt says so), and a quoted message degrades to a marker",
  },
  {
    request: "im:chat.members:read",
    withoutIt: "people in the discussion the agent reads are shown by open_id, not by name",
  },
];

/** The config scope as an app needs it: webhook only ({@link FEISHU_APP_CONFIG_SCOPE}). */
const FEISHU_APP_CONFIG_REQUEST: FeishuScopeRequest = {
  request: FEISHU_APP_CONFIG_SCOPE,
  withoutIt:
    "the Verification Token is not captured and no Request URL is registered for you (add, dev --tunnel, deploy --run)",
};

/**
 * Every scope an app of this ingress needs: what onboarding requests at creation AND what it checks the app holds, so a
 * scope the app is asked for is one whose absence is reported.
 */
export function feishuAppScopes(ingress: FeishuSubscriptionMode): FeishuScopeRequest[] {
  return [...(ingress === "webhook" ? [FEISHU_APP_CONFIG_REQUEST] : []), ...FEISHU_AGENT_SCOPES];
}

/**
 * What a created app carries on top of the platform's agent template — the `addons` merged onto the confirm page. A
 * scope that arrives here needs no console visit; one a tenant withholds is reported after creation (`add-feishu.ts`).
 */
export function feishuAppAddons(ingress: FeishuSubscriptionMode): {
  scopes: { tenant: string[] };
  events: { items: { tenant: string[] } };
} {
  return {
    scopes: { tenant: feishuAppScopes(ingress).map((entry) => entry.request) },
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
