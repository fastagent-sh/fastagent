/**
 * pi-durable's entries as the Agent API publishes them (SPEC.md §6): the conversation's messages, its tool results
 * and its compactions. The harness's own entries (`pi.system`, resets, FastAgent's bookkeeping) are not published, so a
 * published entry's parent is the published entry before it.
 */
import type {
  AssistantMessage,
  ImageContent,
  Message,
  Usage as PiUsage,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { ContentPart, Entry, Json, Usage } from "../../agent-api.ts";
import type { Ids } from "./ids.ts";

/** A message as it was taken: the model saw the record's content, a Caller sees what it sent (`sent`). */
export const USER_ENTRY = "fastagent.user";
/** A write that only places the queued inputs a run that did not answer left waiting (release.ts). */
export const RELEASE_ENTRY = "fastagent.release";

export type UserEntryData = {
  requestId: string;
  /** The first text part as sent, when a command expanded it for the model. */
  sent?: string;
};

const PUBLISHED = new Set([USER_ENTRY, "pi.user", "pi.assistant", "pi.tool-result", "pi.compaction"]);

export function isPublished(record: EntryRecord): boolean {
  return PUBLISHED.has(record.kind) && record.model?.[0] !== undefined;
}

/** The request id a `fastagent.user` entry was submitted with: how the message it names is found. */
export function requestIdOf(record: EntryRecord): string | undefined {
  return record.kind === USER_ENTRY ? (record.data as UserEntryData).requestId : undefined;
}

export interface Published {
  ids: Ids;
  parent: number | undefined;
  /** The message a user entry names, when it names one. */
  message?: { messageId: number; idempotencyKey?: string };
}

export function publishEntry(record: EntryRecord, { ids, parent, message }: Published): Entry {
  const model = record.model?.[0] as Message;
  const ref = (index: number) => imageRef(ids.encode(record.id), index);
  return {
    id: ids.encode(record.id),
    sessionId: ids.encode(record.conversationId),
    ...(parent === undefined ? {} : { parentEntryId: ids.encode(parent) }),
    timestamp: model.timestamp,
    ...published(record, model, ref, ids, message),
  };
}

function published(
  record: EntryRecord,
  model: Message,
  ref: (index: number) => string,
  ids: Ids,
  message: Published["message"],
): Pick<Entry, "kind" | "data"> {
  switch (model.role) {
    case "user": {
      if (record.kind === "pi.compaction") return { kind: "compaction", data: { summary: textOf(model.content) } };
      const content = contentParts(model.content, ref);
      const sent = record.kind === USER_ENTRY ? (record.data as UserEntryData).sent : undefined;
      const first = content[0];
      if (sent !== undefined && first?.type === "text") content[0] = { type: "text", text: sent };
      return {
        kind: "user_message",
        data: {
          content: content as Json,
          ...(message === undefined ? {} : { messageId: ids.encode(message.messageId) }),
          ...(message?.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
        },
      };
    }
    case "assistant":
      return { kind: "assistant_message", data: assistantData(model) };
    case "toolResult":
      return {
        kind: "tool_result",
        data: {
          toolCallId: model.toolCallId,
          toolName: model.toolName,
          isError: model.isError,
          content: contentParts(model.content, ref) as Json,
        },
      };
    default:
      throw new Error(`entry ${record.id} of kind ${record.kind} holds a ${model.role} message`);
  }
}

function assistantData(message: AssistantMessage): Json {
  const toolCalls = message.content.flatMap((block) =>
    block.type === "toolCall" ? [{ id: block.id, name: block.name, args: block.arguments as Json }] : [],
  );
  const thinking = thinkingOf(message);
  const outcome = replyOutcome(message);
  return {
    text: replyText(message),
    ...(thinking === undefined ? {} : { thinking }),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(outcome === undefined ? {} : { outcome }),
    usage: usageOf(message.usage),
  };
}

function replyOutcome(message: AssistantMessage): Json | undefined {
  const failed = (status: string): Json =>
    message.errorMessage === undefined ? { status } : { status, error: { message: message.errorMessage } };
  switch (message.stopReason) {
    case "error":
      return failed("failed");
    case "aborted":
      return failed("aborted");
    case "length":
      return { status: "truncated" };
    default:
      return undefined;
  }
}

export function replyText(message: Pick<AssistantMessage, "content">): string {
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** The model's reasoning as a Caller may show it: a redacted block's placeholder is not reasoning. */
export function thinkingOf(message: Pick<AssistantMessage, "content">): string | undefined {
  const text = message.content
    .flatMap((block) => (block.type === "thinking" && block.redacted !== true ? [block.thinking] : []))
    .join("");
  return text === "" ? undefined : text;
}

export function hasToolCalls(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === "toolCall");
}

export function usageOf(usage: Pick<PiUsage, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">): Usage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    cost: usage.cost.total,
  };
}

function textOf(content: UserMessage["content"]): string {
  return typeof content === "string"
    ? content
    : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function contentParts(content: string | (TextContent | ImageContent)[], ref: (index: number) => string): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part, index) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", mimeType: part.mimeType, ref: ref(index) },
  );
}

/** A ref names the entry and the part of its content that holds the image: images live inline in the entry. */
function imageRef(entryId: string, index: number): string {
  return `${entryId}:${index}`;
}

export function parseImageRef(ref: string): { entryId: string; index: number } | undefined {
  const at = ref.lastIndexOf(":");
  const index = ref.slice(at + 1);
  if (at <= 0 || !/^(0|[1-9][0-9]{0,5})$/.test(index)) return undefined;
  return { entryId: ref.slice(0, at), index: Number(index) };
}

export function imageAt(record: EntryRecord, index: number): ImageContent | undefined {
  const model = record.model?.[0];
  if (!isPublished(record) || (model?.role !== "user" && model?.role !== "toolResult")) return undefined;
  if (typeof model.content === "string") return undefined;
  const part = model.content[index];
  return part?.type === "image" ? part : undefined;
}
