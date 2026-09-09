/** Pure Feishu/Lark message normalization. */
import type {
  FeishuMention,
  FeishuMessage,
  FeishuMessageEvent,
  FeishuResourceKind,
  NormalizedFeishuMessage,
} from "./model.ts";

interface DecodedFeishuResource {
  kind: FeishuResourceKind;
  key: string;
  name?: string;
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
  placeholder?: string;
  elements?: unknown;
  [k: string]: unknown;
}

/**
 * Render one paragraph of tagged nodes to a line, collecting any resource it carries INTO the sink the caller supplies
 * — or none, when the caller passes no sink.
 */
function renderNodes(nodes: unknown, resources?: DecodedFeishuResource[]): string {
  if (!Array.isArray(nodes)) return "";
  const parts: string[] = [];
  for (const raw of nodes) {
    if (typeof raw !== "object" || raw === null) continue;
    const node = raw as PostNode;
    if (node.tag === "at") {
      parts.push(`@${nonEmptyString(node.user_name) ?? nonEmptyString(node.user_id) ?? "user"}`);
    } else if (node.tag === "a") {
      parts.push(node.href ? `${nonEmptyString(node.text) ?? node.href} (${node.href})` : (node.text ?? ""));
    } else if (node.tag === "img") {
      const key = nonEmptyString(node.image_key);
      if (key) resources?.push({ kind: "image", key });
      parts.push("[image]");
    } else if (node.tag === "media") {
      const key = nonEmptyString(node.file_key);
      if (key) resources?.push({ kind: "video", key, name: nonEmptyString(node.file_name) });
      parts.push("[video]");
    } else if (node.tag === "code_block") {
      parts.push(
        `\n\`\`\`${nonEmptyString(node.language)?.toLowerCase() ?? ""}\n${nonEmptyString(node.text) ?? ""}\n\`\`\`\n`,
      );
    } else if (node.tag === "note") {
      const nested = renderNodes(node.elements, resources);
      if (nested) parts.push(nested);
    } else if (nonEmptyString(node.text)) {
      parts.push(node.text as string);
    } else if (nonEmptyString(node.placeholder)) {
      parts.push(node.placeholder as string);
    }
  }
  return parts.join("").trim();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
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

/** Decode one JSON-string message body. */
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
        const line = renderNodes(paragraph, resources);
        if (line) lines.push(line);
      }
      return { text: lines.join("\n"), resources };
    }
    // A CARD, as the platform hands it BACK.
    case "interactive":
    case "card": {
      const lines: string[] = [];
      const title = nonEmptyString(content.title);
      if (title) lines.push(title);
      const paragraphs = Array.isArray(content.elements) ? (content.elements as unknown[]) : [];
      for (const paragraph of paragraphs) {
        // NO resource sink, deliberately.
        const line = Array.isArray(paragraph) ? renderNodes(paragraph) : renderNodes([paragraph]);
        if (line) lines.push(line);
      }
      // An unrenderable card (all controls, no labels) still says something by existing — keep the marker rather than
      // returning empty, which reads as "the message was blank".
      return { text: lines.length > 0 ? lines.join("\n") : `[${rawType} message]`, resources };
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
      if (key) resources.push({ kind: "audio", key, name: "voice-message" });
      return { text: "[voice message]", resources };
    }
    case "media": {
      const key = nonEmptyString(content.file_key);
      const name = nonEmptyString(content.file_name);
      if (key) resources.push({ kind: "video", key, name });
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

export function normalizeFeishuMessage(event: FeishuMessageEvent): NormalizedFeishuMessage | null {
  const message = event.message;
  if (!message || typeof message.message_id !== "string" || typeof message.chat_id !== "string") return null;

  const decoded = decodeFeishuContent(message);
  return {
    conversation: {
      chatId: message.chat_id,
      threadId: message.thread_id,
    },
    content: {
      text: decoded.text,
      hasMentions: (message.mentions?.length ?? 0) > 0,
      resources: decoded.resources.map((resource) => ({ ...resource, messageId: message.message_id })),
    },
  };
}
