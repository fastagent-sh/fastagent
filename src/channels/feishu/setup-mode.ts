/** Feishu/Lark app-level event subscription choice used by onboarding and scaffolding. */
export type FeishuSubscriptionMode = "webhook" | "websocket";

/** Onboarding choice for group visibility. `context` needs the tenant-wide group-message scope; the
 * runtime remains capability-driven because the platform, not channel source, decides which events
 * are delivered. */
export type FeishuGroupBehavior = "context" | "mentions";

/** The sensitive tenant scope behind both bare replies in the agent's threads and group context buffering. */
export const FEISHU_GROUP_CONTEXT_SCOPE = "im:message.group_msg";

/** Reading a QUOTED message by id, so an ask carries what it replies to (participant-model.md §8).
 *  INDEPENDENT of the delivery scope above and of the group posture: the read runs in every chat type
 *  (a p2p thread's opening ask, any quoted @mention in a group). It is also a softer dependency —
 *  without it everything still works, and an unreadable quote degrades to a marker in the prompt.
 *  Bundled into the context-aware request only because that path already needs an approval round; a
 *  mention-only app wanting referents must add it by hand. */
export const FEISHU_MESSAGE_READ_SCOPE = "im:message:readonly";

/** A scope the onboarding asks for, plus any BROADER spelling that already satisfies it. One concept,
 *  so adding a superset means editing the entry — not every call site that tests a scope. */
export interface FeishuScopeRequest {
  /** What to add to the app draft when nothing satisfies it. Always counts as satisfying itself. */
  request: string;
  /** EXTRA spellings that also count — supersets. Optional; `request` is implicit. Modelled this way
   *  so a request that can never be satisfied (a list omitting its own `request`) cannot be
   *  written: onboarding would add the scope, the tenant would grant it, and it would still read as
   *  missing forever. */
  supersets?: string[];
}

/** Whether `predicate` holds for any spelling that satisfies this request. */
export function scopeSatisfied(entry: FeishuScopeRequest, predicate: (name: string) => boolean): boolean {
  return [entry.request, ...(entry.supersets ?? [])].some(predicate);
}

/** Reading a quoted message: `im:message` is the read/write superset, so an app holding it can already
 *  do so — checking only the readonly spelling would warn a correctly configured app forever and push
 *  its author into a redundant approval round. Exported on its own because the serving-time capability
 *  report asks the same question, and a second mechanism there is what this type exists to prevent. */
export const FEISHU_MESSAGE_READ_REQUEST: FeishuScopeRequest = {
  request: FEISHU_MESSAGE_READ_SCOPE,
  supersets: ["im:message"],
};

/** What `--group-behavior context` REQUESTS in one approval round — not a dependency set. Only the
 *  delivery scope is required for the context path; the read scope rides along because it shares the
 *  round and its absence merely degrades quoted messages to a marker. */
export const FEISHU_CONTEXT_ONBOARDING_SCOPES: FeishuScopeRequest[] = [
  { request: FEISHU_GROUP_CONTEXT_SCOPE },
  FEISHU_MESSAGE_READ_REQUEST,
];
