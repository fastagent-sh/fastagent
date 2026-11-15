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
 * agent takes part in its rooms like a colleague, so every app gets all of it, requested at
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
    request: "im:message.reactions:write_only",
    supersets: ["im:message"], // the read/write superset
    withoutIt: "a message waiting behind a running task gets no 👀 while it waits",
  },
  {
    request: "im:chat.members:read",
    withoutIt: "people in the discussion the agent reads are shown by open_id, not by name",
  },
];

/**
 * What a created app carries on top of the platform's agent template — the `addons` merged onto the confirm page. A
 * scope that arrives here needs no console visit; one a tenant withholds is reported after creation (`setup.ts`).
 */
export function feishuAppAddons(): {
  scopes: { tenant: string[] };
  events: { items: { tenant: string[] } };
} {
  return {
    scopes: { tenant: FEISHU_AGENT_SCOPES.map((entry) => entry.request) },
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
