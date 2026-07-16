/**
 * Durable context buffer for human group messages that do NOT currently summon the Feishu/Lark Agent.
 * Entries are bucketed by conversation place (main chat, or one concrete thread root) and folded into
 * the next answered turn in that place. The consume protocol mirrors Telegram: peek without clearing,
 * then commit exactly that snapshot only after the Agent emits `completed`.
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../state.ts";
import type { NormalizedFeishuMessage } from "./model.ts";

const BUFFER_MAX_CHARS = 4000;
const BUFFER_ATTACH_MAX = 3;

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

export interface FeishuContextBuffer {
  /** Persist before webhook ACK. A failed write throws and rolls memory back for safe redelivery. */
  push(placeKey: string, entry: FeishuBufferEntry): void;
  /** Render and snapshot without clearing. */
  peek(placeKey: string): { text: string; consumed: FeishuBufferEntry[] };
  /** Remove only the consumed snapshot after `completed`; a post-ACK write failure is logged. */
  commit(placeKey: string, consumed: FeishuBufferEntry[]): void;
}

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
  const load = (): Map<string, FeishuBufferEntry[]> => {
    const raw = loadStateFile(path);
    if (raw === undefined) return new Map();
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.values(raw).every((entries) => Array.isArray(entries) && entries.every(isEntry))
    ) {
      return new Map(Object.entries(raw as Record<string, FeishuBufferEntry[]>));
    }
    log.warn(`${label} unexpected shape in ${path} — starting with an empty context buffer`);
    return new Map();
  };
  const buffers = load();
  const persist = (): void => saveStateFile(path, Object.fromEntries(buffers));

  return {
    push(placeKey, entry) {
      const previous = buffers.get(placeKey);
      const entries = previous ? [...previous] : [];
      entries.push(entry);
      let total = entries.reduce((sum, candidate) => sum + bufferLine(candidate).length + 1, 0);
      while (entries.length > 1 && total > BUFFER_MAX_CHARS) {
        const dropped = entries.shift();
        if (dropped) total -= bufferLine(dropped).length + 1;
      }
      buffers.set(placeKey, entries);
      try {
        persist();
      } catch (error) {
        if (previous) buffers.set(placeKey, previous);
        else buffers.delete(placeKey);
        throw error;
      }
    },
    peek(placeKey) {
      const entries = buffers.get(placeKey) ?? [];
      return { text: entries.map(bufferLine).join("\n"), consumed: [...entries] };
    },
    commit(placeKey, consumed) {
      const entries = buffers.get(placeKey);
      if (!entries) return;
      const remaining = entries.filter((entry) => !consumed.includes(entry));
      if (remaining.length === 0) buffers.delete(placeKey);
      else buffers.set(placeKey, remaining);
      try {
        persist();
      } catch (error) {
        log.error(
          `${label} context-buffer write failed post-ACK (a restart may re-fold answered discussion): ${String(error)}`,
        );
      }
    },
  };
}
