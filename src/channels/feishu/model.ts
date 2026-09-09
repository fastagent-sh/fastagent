/** Canonical Feishu/Lark protocol and normalized-message models. */

/** The v2 event envelope header. */
export interface FeishuEventHeader {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  token?: string;
  app_id?: string;
  tenant_key?: string;
  [k: string]: unknown;
}

/** One entry of a message's `mentions` array. */
export interface FeishuMention {
  key: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
  name?: string;
  tenant_key?: string;
  [k: string]: unknown;
}

/** A received `im.message.receive_v1` message. */
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
  };
  content: {
    text: string;
    hasMentions: boolean;
    resources: FeishuResourceRef[];
  };
}
