/** Feishu/Lark's half of the shared context buffer (mechanics + consume protocol: ../kit/context-buffer.ts). */
import {
  capBufferedRefs,
  BUFFER_LINE_MAX_CHARS,
  type ContextBuffer,
  createContextBuffer as createGenericContextBuffer,
} from "../kit/context-buffer.ts";
import { truncateCodePointPrefix } from "../kit/text.ts";
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

/** The place a message belongs to: the main chat, or a thread within it. */
export function feishuBufferPlaceKey(
  conversation: Pick<NormalizedFeishuMessage["conversation"], "chatId" | "threadId">,
): string {
  return conversation.threadId ? `${conversation.chatId}:thread:${conversation.threadId}` : conversation.chatId;
}

/** One-line, bounded background text. */
export function feishuBufferText(text: string): string {
  return truncateCodePointPrefix(text.replace(/\s+/g, " ").trim(), BUFFER_LINE_MAX_CHARS);
}

function resourceIdentity(resource: FeishuBufferedResource): string {
  return `${resource.messageId}\u0000${resource.key}`;
}

/** Select the most recent background resources, excluding resources already primary on this turn. */
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
  const files = capBufferedRefs(refs((entry) => entry.files, primary.files));
  const images = capBufferedRefs(refs((entry) => entry.images, primary.images));
  return { files: files.kept, images: images.kept, skipped: files.skipped + images.skipped };
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
  return createGenericContextBuffer({
    path,
    label,
    isEntry,
    line: bufferLine,
  });
}
