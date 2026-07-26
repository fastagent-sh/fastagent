/** Feishu/Lark app-level event subscription choice used by onboarding and scaffolding. */
export type FeishuSubscriptionMode = "webhook" | "websocket";

/** Onboarding choice for group visibility. `context` needs the tenant-wide group-message scope; the
 * runtime remains capability-driven because the platform, not channel source, decides which events
 * are delivered. */
export type FeishuGroupBehavior = "context" | "mentions";

/** The sensitive tenant scope behind both bare replies in the agent's threads and group context buffering. */
export const FEISHU_GROUP_CONTEXT_SCOPE = "im:message.group_msg";

/** Reading a QUOTED message by id, so a thread's opening ask carries what it replies to (participant-model.md §8). A SEPARATE permission from the delivery scope above, and a softer dependency: without it group
 *  messages are still delivered and the thread rule still works — an unreadable quote degrades to a
 *  marker in the prompt. Requested together so the recommended path does not half-work. */
export const FEISHU_MESSAGE_READ_SCOPE = "im:message:readonly";

/** Both scopes the context-aware path depends on. */
export const FEISHU_GROUP_CONTEXT_SCOPES = [FEISHU_GROUP_CONTEXT_SCOPE, FEISHU_MESSAGE_READ_SCOPE];
