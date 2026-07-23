/**
 * Canonical Feishu/Lark protocol and normalized-message models.
 *
 * Raw wire types stay at the webhook/policy boundary: authors' existing `route(event)` callbacks keep
 * receiving the platform event unchanged. The narrow normalized shape below owns only what currently
 * benefits from normalization: conversation-place identity, decoded content, mention presence, and
 * message-scoped resource locators. Do not pre-model unused transport metadata for a future ingress.
 */

/** The v2 event envelope header. Feishu and Lark use the same wire shape. */
export interface FeishuEventHeader {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  token?: string;
  app_id?: string;
  tenant_key?: string;
  [k: string]: unknown;
}

/** One entry of a message's `mentions` array. `key` is the placeholder carried in text content. */
export interface FeishuMention {
  key: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
  name?: string;
  mentioned_type?: string;
  tenant_key?: string;
  [k: string]: unknown;
}

/** A received `im.message.receive_v1` message. `content` is JSON encoded according to `message_type`. */
export interface FeishuMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time?: string;
  update_time?: string;
  chat_id: string;
  thread_id?: string;
  chat_type: string;
  message_type: string;
  content: string;
  mentions?: FeishuMention[];
  user_agent?: string;
  lark_agent_context?: { active_chat_id?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface FeishuSender {
  sender_id?: { open_id?: string; user_id?: string; union_id?: string };
  sender_type?: string;
  tenant_key?: string;
  [k: string]: unknown;
}

/** The `event` member of a v2 `im.message.receive_v1` envelope. */
export interface FeishuMessageEvent {
  sender?: FeishuSender;
  message?: FeishuMessage;
  [k: string]: unknown;
}

/** Existing public route result: act with these overrides, or return null to ignore the message. */
export interface FeishuRoute {
  session?: string;
  chatId?: string;
  text?: string;
}

export type FeishuResourceKind = "image" | "file" | "audio" | "video";

/**
 * A resource locator. User-sent resources are scoped by BOTH their carrying message id and resource
 * key; a bare file_key/image_key is insufficient for the message-resource download API.
 */
interface FeishuResourceRef {
  kind: FeishuResourceKind;
  messageId: string;
  key: string;
  name?: string;
}

/** Narrow internal representation shared by the Feishu reference and Lark compatibility clouds. */
export interface NormalizedFeishuMessage {
  conversation: {
    chatId: string;
    threadId?: string;
    rootId?: string;
  };
  content: {
    text: string;
    hasMentions: boolean;
    resources: FeishuResourceRef[];
  };
}
