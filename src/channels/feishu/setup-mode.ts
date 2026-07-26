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

/** Both scopes the context-aware path depends on. */
export const FEISHU_GROUP_CONTEXT_SCOPES = [FEISHU_GROUP_CONTEXT_SCOPE, FEISHU_MESSAGE_READ_SCOPE];
