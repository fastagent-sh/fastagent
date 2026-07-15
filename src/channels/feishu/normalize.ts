/**
 * Pure Feishu/Lark message normalization. The platform sends a stable event shell but encodes the
 * actual message body as a JSON string selected by `message_type`; this module is the one decoder and
 * converts resource keys into message-scoped locators before the turn engine sees them.
 */
import type { FeishuCloudKind } from "./cloud.ts";
import type {
  FeishuEventHeader,
  FeishuMention,
  FeishuMessage,
  FeishuMessageEvent,
  FeishuResourceKind,
  NormalizedFeishuMessage,
} from "./model.ts";

export interface DecodedFeishuResource {
  kind: FeishuResourceKind;
  key: string;
  name?: string;
  durationMs?: number;
  coverImageKey?: string;
}

export interface DecodedFeishuContent {
  text: string;
  resources: DecodedFeishuResource[];
}

/** One node of a post (rich text) paragraph — text/a/at/img/media/code_block and friends. */
interface PostNode {
  tag?: string;
  text?: string;
  href?: string;
  user_name?: string;
  user_id?: string;
  image_key?: string;
  file_key?: string;
  file_name?: string;
  language?: string;
  [k: string]: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Restore text-message mention placeholders to readable names. */
function restoreMentions(text: string, mentions: FeishuMention[] | undefined): string {
  let out = text;
  for (const mention of mentions ?? []) {
    if (!mention.key) continue;
    out = out.split(mention.key).join(`@${mention.name ?? "user"}`);
  }
  return out;
}

/**
 * Decode one JSON-string message body. Unknown or malformed external input degrades to a visible
 * marker rather than throwing, preserving the channel's existing fail-visible prompt behavior.
 */
export function decodeFeishuContent(
  message: Pick<FeishuMessage, "message_type" | "content" | "mentions">,
): DecodedFeishuContent {
  const rawType = typeof message.message_type === "string" ? message.message_type : "unknown";
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(message.content) as Record<string, unknown>;
    if (typeof content !== "object" || content === null) throw new Error("not an object");
  } catch {
    return { text: `[unreadable ${rawType} message]`, resources: [] };
  }

  const resources: DecodedFeishuResource[] = [];
  switch (rawType) {
    case "text":
      return { text: restoreMentions(nonEmptyString(content.text) ?? "", message.mentions), resources };
    case "post": {
      const lines: string[] = [];
      const title = nonEmptyString(content.title);
      if (title) lines.push(title);
      const paragraphs = Array.isArray(content.content) ? (content.content as PostNode[][]) : [];
      for (const paragraph of paragraphs) {
        if (!Array.isArray(paragraph)) continue;
        const parts: string[] = [];
        for (const node of paragraph) {
          if (typeof node !== "object" || node === null) continue;
          if (node.tag === "at") {
            parts.push(`@${nonEmptyString(node.user_name) ?? nonEmptyString(node.user_id) ?? "user"}`);
          } else if (node.tag === "a") {
            parts.push(node.href ? `${nonEmptyString(node.text) ?? node.href} (${node.href})` : (node.text ?? ""));
          } else if (node.tag === "img") {
            const key = nonEmptyString(node.image_key);
            if (key) resources.push({ kind: "image", key });
            parts.push("[image]");
          } else if (node.tag === "media") {
            const key = nonEmptyString(node.file_key);
            if (key) resources.push({ kind: "video", key, name: nonEmptyString(node.file_name) });
            parts.push("[video]");
          } else if (node.tag === "code_block") {
            parts.push(
              `\n\`\`\`${nonEmptyString(node.language)?.toLowerCase() ?? ""}\n${nonEmptyString(node.text) ?? ""}\n\`\`\`\n`,
            );
          } else if (nonEmptyString(node.text)) {
            parts.push(node.text as string);
          }
        }
        const line = parts.join("").trim();
        if (line) lines.push(line);
      }
      return { text: lines.join("\n"), resources };
    }
    case "image": {
      const key = nonEmptyString(content.image_key);
      if (key) resources.push({ kind: "image", key });
      return { text: "[image]", resources };
    }
    case "file": {
      const key = nonEmptyString(content.file_key);
      const name = nonEmptyString(content.file_name);
      if (key) resources.push({ kind: "file", key, name });
      return { text: `[file: ${name ?? "file"}]`, resources };
    }
    case "audio": {
      const key = nonEmptyString(content.file_key);
      if (key)
        resources.push({
          kind: "audio",
          key,
          name: "voice-message",
          durationMs: finiteNumber(content.duration),
        });
      return { text: "[voice message]", resources };
    }
    case "media": {
      const key = nonEmptyString(content.file_key);
      const name = nonEmptyString(content.file_name);
      if (key)
        resources.push({
          kind: "video",
          key,
          name,
          durationMs: finiteNumber(content.duration),
          coverImageKey: nonEmptyString(content.image_key),
        });
      return { text: `[video: ${name ?? "video"}]`, resources };
    }
    case "location": {
      const name = nonEmptyString(content.name);
      return {
        text: `[location: ${name ? `${name} — ` : ""}${nonEmptyString(content.latitude) ?? "?"},${nonEmptyString(content.longitude) ?? "?"}]`,
        resources,
      };
    }
    default:
      return { text: `[${rawType} message]`, resources };
  }
}

export interface NormalizeFeishuMessageOptions {
  cloud: FeishuCloudKind;
  appId?: string;
  header?: FeishuEventHeader;
  botOpenId?: string;
}

/** Normalize one verified message event. Returns null only when its required identity is absent. */
export function normalizeFeishuMessage(
  event: FeishuMessageEvent,
  options: NormalizeFeishuMessageOptions,
): NormalizedFeishuMessage | null {
  const message = event.message;
  if (!message || typeof message.message_id !== "string" || typeof message.chat_id !== "string") return null;

  const decoded = decodeFeishuContent(message);
  const senderIds = event.sender?.sender_id;
  return {
    source: {
      cloud: options.cloud,
      appId: options.header?.app_id ?? options.appId,
      tenantKey: options.header?.tenant_key,
    },
    delivery: {
      eventId: options.header?.event_id,
      messageId: message.message_id,
      eventCreatedAt: finiteNumber(options.header?.create_time),
      messageCreatedAt: finiteNumber(message.create_time),
    },
    conversation: {
      chatId: message.chat_id,
      chatType: message.chat_type,
      threadId: message.thread_id,
      rootId: message.root_id,
      parentId: message.parent_id,
    },
    sender: {
      type: event.sender?.sender_type,
      openId: senderIds?.open_id,
      userId: senderIds?.user_id,
      unionId: senderIds?.union_id,
      tenantKey: event.sender?.tenant_key,
    },
    content: {
      rawType: message.message_type,
      text: decoded.text,
      mentions: (message.mentions ?? []).map((mention) => ({
        key: mention.key,
        openId: mention.id?.open_id,
        userId: mention.id?.user_id,
        unionId: mention.id?.union_id,
        name: mention.name,
        isBot: options.botOpenId !== undefined && mention.id?.open_id === options.botOpenId,
      })),
      resources: decoded.resources.map((resource) => ({ ...resource, messageId: message.message_id })),
    },
  };
}
