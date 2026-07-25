/** Feishu/Lark app-level event subscription choice used by onboarding and scaffolding. */
export type FeishuSubscriptionMode = "webhook" | "websocket";

/** Onboarding choice for group visibility. `context` needs the tenant-wide group-message scope; the
 * runtime remains capability-driven because the platform, not channel source, decides which events
 * are delivered. */
export type FeishuGroupBehavior = "context" | "mentions";

/** The sensitive tenant scope behind both bare replies in the agent's threads and group context buffering. */
export const FEISHU_GROUP_CONTEXT_SCOPE = "im:message.group_msg";

/** Reading a thread's senders is what admits a bare reply (docs/design/participant-model.md §3), and it
 *  is a SEPARATE permission from the delivery scope above: without it the platform still pushes group
 *  messages, but the channel cannot tell a two-party thread from a crowded one and stays mention-only.
 *  Requested together with the delivery scope so the recommended path does not half-work. */
export const FEISHU_MESSAGE_READ_SCOPE = "im:message:readonly";

/** Both scopes the context-aware path depends on. */
export const FEISHU_GROUP_CONTEXT_SCOPES = [FEISHU_GROUP_CONTEXT_SCOPE, FEISHU_MESSAGE_READ_SCOPE];
