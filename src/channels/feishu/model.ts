/**
 * Canonical Feishu/Lark protocol and normalized-message models.
 *
 * Raw wire types stay at the webhook/policy boundary: authors' existing `route(event)` callbacks keep
 * receiving the platform event unchanged. The turn engine consumes {@link NormalizedFeishuMessage}
 * instead, so transport envelopes, JSON-string message bodies, and platform field naming do not leak
 * further into persistence, attachment resolution, or future ingress implementations.
 */
import type { FeishuCloudKind } from "./cloud.ts";

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

export type FeishuReplyPolicy = "required" | "agent-decides";

/** Existing public route result: act with these overrides, or return null to ignore the message. */
export interface FeishuRoute {
  session?: string;
  chatId?: string;
  text?: string;
  /** Whether delivery is mandatory (the normal explicit summon) or the Agent may stay silent. */
  replyPolicy?: FeishuReplyPolicy;
}

export type FeishuResourceKind = "image" | "file" | "audio" | "video" | "sticker";

/**
 * A resource locator. User-sent resources are scoped by BOTH their carrying message id and resource
 * key; a bare file_key/image_key is insufficient for the message-resource download API.
 */
export interface FeishuResourceRef {
  kind: FeishuResourceKind;
  messageId: string;
  key: string;
  name?: string;
  durationMs?: number;
  coverImageKey?: string;
}

export interface NormalizedFeishuMention {
  key: string;
  openId?: string;
  userId?: string;
  unionId?: string;
  name?: string;
  isBot: boolean;
}

/** Stable internal representation shared by the Feishu reference cloud and Lark compatibility cloud. */
export interface NormalizedFeishuMessage {
  source: {
    cloud: FeishuCloudKind;
    appId?: string;
    tenantKey?: string;
  };
  delivery: {
    eventId?: string;
    messageId: string;
    eventCreatedAt?: number;
    messageCreatedAt?: number;
  };
  conversation: {
    chatId: string;
    chatType: string;
    threadId?: string;
    rootId?: string;
    parentId?: string;
  };
  sender: {
    type?: string;
    openId?: string;
    userId?: string;
    unionId?: string;
    tenantKey?: string;
  };
  content: {
    rawType: string;
    text: string;
    mentions: NormalizedFeishuMention[];
    resources: FeishuResourceRef[];
  };
}
