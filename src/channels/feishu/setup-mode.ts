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

/** Every scope that authorizes `GET /open-apis/im/v1/messages/{id}`. `im:message` is the read/write
 *  superset, so an app holding it can already read a quoted message — checking only the readonly
 *  spelling would warn a correctly configured app forever and push its author into a redundant
 *  approval round. Request the narrow one; accept either. */
export const FEISHU_MESSAGE_READ_SCOPES = [FEISHU_MESSAGE_READ_SCOPE, "im:message"];

/** A scope the onboarding asks for, and every spelling that already satisfies it. Kept as one concept
 *  so adding another superset means editing this table, not every call site that tests a scope. */
export interface FeishuScopeRequest {
  /** What to add to the app draft when nothing satisfies it. */
  request: string;
  /** Any of these counts as having it. */
  satisfiedBy: string[];
}

/** Whether `predicate` holds for any spelling that satisfies this request. */
export function scopeSatisfied(entry: FeishuScopeRequest, predicate: (name: string) => boolean): boolean {
  return entry.satisfiedBy.some(predicate);
}

/** What `--group-behavior context` REQUESTS in one approval round — not a dependency set. Only the
 *  delivery scope is required for the context path; the read scope rides along because it shares the
 *  round and its absence merely degrades quoted messages to a marker. */
export const FEISHU_CONTEXT_ONBOARDING_SCOPES: FeishuScopeRequest[] = [
  { request: FEISHU_GROUP_CONTEXT_SCOPE, satisfiedBy: [FEISHU_GROUP_CONTEXT_SCOPE] },
  { request: FEISHU_MESSAGE_READ_SCOPE, satisfiedBy: FEISHU_MESSAGE_READ_SCOPES },
];
