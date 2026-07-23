/**
 * Feishu/Lark's half of the shared context buffer (mechanics + consume protocol:
 * ../context-buffer.ts): the entry shape, its fold-line rendering, place-key derivation, and
 * buffered-resource selection. Entries are bucketed by conversation place (main chat, or one
 * concrete thread root) and folded into the next answered turn in that place.
 */
import {
  BUFFER_ATTACH_MAX,
  type ContextBuffer,
  createContextBuffer as createGenericContextBuffer,
} from "../context-buffer.ts";
import type { NormalizedFeishuMessage } from "./model.ts";

export interface FeishuBufferedResource {
  messageId: string;
  key: string;
  name?: string;
}

export interface FeishuBufferEntry {
  sender: string;
  body: string;
  messageId: string;
  replyTo?: string;
  files?: FeishuBufferedResource[];
  images?: FeishuBufferedResource[];
}

/** A background resource carried into a later turn, with attribution for its prompt manifest. */
export interface FeishuBufferedRef extends FeishuBufferedResource {
  from: string;
}

function bufferLine(entry: FeishuBufferEntry): string {
  const meta = [`msg ${entry.messageId}`, entry.replyTo ? `reply to msg ${entry.replyTo}` : undefined]
    .filter(Boolean)
    .join(", ");
  return `${entry.sender} (${meta}): ${entry.body}`;
}

/** Main-chat discussion stays in the chat bucket; a topic uses its stable root id (thread id fallback). */
export function feishuBufferPlaceKey(
  conversation: Pick<NormalizedFeishuMessage["conversation"], "chatId" | "rootId" | "threadId">,
): string {
  const topic = conversation.rootId ?? conversation.threadId;
  return topic ? `${conversation.chatId}:root:${topic}` : conversation.chatId;
}

/** One-line, bounded background text. Resource-only messages already carry a visible decoder marker. */
export function feishuBufferText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 280);
}

function resourceIdentity(resource: FeishuBufferedResource): string {
  return `${resource.messageId}\u0000${resource.key}`;
}

/**
 * Select the most recent background resources, excluding resources already primary on this turn. A
 * resource is message-scoped in Feishu/Lark, so identity is `message_id + key`, never the bare key.
 */
export function collectFeishuBufferedAttachments(
  consumed: FeishuBufferEntry[],
  primary: { files: FeishuBufferedResource[]; images: FeishuBufferedResource[] },
): { files: FeishuBufferedRef[]; images: FeishuBufferedRef[]; skipped: number } {
  const refs = (
    pick: (entry: FeishuBufferEntry) => FeishuBufferedResource[] | undefined,
    primaryRefs: FeishuBufferedResource[],
  ): FeishuBufferedRef[] => {
    const excluded = new Set(primaryRefs.map(resourceIdentity));
    const seen = new Set<string>();
    const out: FeishuBufferedRef[] = [];
    for (const entry of consumed) {
      for (const resource of pick(entry) ?? []) {
        const identity = resourceIdentity(resource);
        if (excluded.has(identity) || seen.has(identity)) continue;
        seen.add(identity);
        out.push({ ...resource, from: entry.sender });
      }
    }
    return out;
  };
  const files = refs((entry) => entry.files, primary.files);
  const images = refs((entry) => entry.images, primary.images);
  return {
    files: files.slice(-BUFFER_ATTACH_MAX),
    images: images.slice(-BUFFER_ATTACH_MAX),
    skipped: Math.max(0, files.length - BUFFER_ATTACH_MAX) + Math.max(0, images.length - BUFFER_ATTACH_MAX),
  };
}

export type FeishuContextBuffer = ContextBuffer<FeishuBufferEntry>;

function isResource(value: unknown): value is FeishuBufferedResource {
  const resource = value as FeishuBufferedResource;
  return (
    typeof resource?.messageId === "string" &&
    typeof resource.key === "string" &&
    (resource.name === undefined || typeof resource.name === "string")
  );
}

function isEntry(value: unknown): value is FeishuBufferEntry {
  const entry = value as FeishuBufferEntry;
  const resources = (candidate: unknown): boolean =>
    candidate === undefined || (Array.isArray(candidate) && candidate.every(isResource));
  return (
    typeof entry?.sender === "string" &&
    typeof entry.body === "string" &&
    typeof entry.messageId === "string" &&
    (entry.replyTo === undefined || typeof entry.replyTo === "string") &&
    resources(entry.files) &&
    resources(entry.images)
  );
}

export function createFeishuContextBuffer(path: string, label: string): FeishuContextBuffer {
  return createGenericContextBuffer({ path, label, isEntry, line: bufferLine });
}
