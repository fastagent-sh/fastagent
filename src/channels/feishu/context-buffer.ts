/**
 * Feishu/Lark's half of the shared context buffer (mechanics + consume protocol:
 * ../context-buffer.ts): the entry shape, its fold-line rendering, place-key derivation, and
 * buffered-resource selection. Entries are bucketed by conversation place (main chat, or one
 * concrete thread root) and folded into the next answered turn in that place.
 */
import { log } from "../../log.ts";
import {
  BUFFER_ATTACH_MAX,
  BUFFER_LINE_MAX_CHARS,
  type ContextBuffer,
  createContextBuffer as createGenericContextBuffer,
} from "../context-buffer.ts";
import { loadStateFile, saveStateFile } from "../state.ts";
import { truncateCodePointPrefix } from "../text.ts";
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

/**
 * The place a message belongs to: the main chat, or a thread within it. Keyed by `thread_id`, the
 * platform's own identity for a side conversation — NOT `root_id`, which tracks the reply chain and
 * can differ between messages of one thread (which would split a thread's context across buckets).
 * A quoted reply outside a thread carries a root but is main-chat discussion, so it buckets there.
 *
 * Its own namespace, deliberately: this names a BUCKET of undelivered text, while `parse.ts`'s
 * `placeKey` names a SESSION. Nothing here claims anything about that session — unlike thread
 * participation, which asserts "the agent answered into this memory" and is therefore keyed by the
 * session itself. Re-keying either one leaves the other correct, and converging them now would strand
 * live buckets for no gain (Slack keeps its own shape for the same reason).
 */
export function feishuBufferPlaceKey(
  conversation: Pick<NormalizedFeishuMessage["conversation"], "chatId" | "threadId">,
): string {
  return conversation.threadId ? `${conversation.chatId}:thread:${conversation.threadId}` : conversation.chatId;
}

/** One-line, bounded background text. Resource-only messages already carry a visible decoder marker. */
export function feishuBufferText(text: string): string {
  return truncateCodePointPrefix(text.replace(/\s+/g, " ").trim(), BUFFER_LINE_MAX_CHARS);
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

/**
 * Buckets from the pre-participant-model keying (`<chat>:root:<root_id>`) can never be produced again —
 * a place is `<chat>` or `<chat>:thread:<thread_id>` — so nothing could ever fold or clear them, and
 * they would hold chat content on disk forever. Dropped here, before the buffer loads, so the shared
 * kernel never learns about a key shape one channel retired.
 *
 * TWO one-time losses, both accepted and both logged by count. (1) The retired shape covered every
 * thread bucket and every main-chat quoted-reply bucket, so buffered discussion in threads does not
 * survive the upgrade — it becomes unreachable BECAUSE of the re-keying, not before it. (2)
 * `turns.json` persists each in-flight turn's `bufferKey` verbatim and this runs before turn recovery,
 * so a turn spanning the upgrade finds its bucket already gone. Sparing referenced keys would couple
 * the buffer to the turn store to protect a single upgrade, and would not help (1) at all.
 *
 * PERMANENT, unlike the `owned-threads.json` cleanup it otherwise resembles. That one leaves an inert
 * orphan file, so deleting it a release later is free; this one is what stops user chat content
 * lingering, and a deployment that skips from before the model to well after it would never run an
 * expired version of this code. The standing cost is one key scan at load, and nothing when no retired
 * key is present.
 */
function dropRetiredBuckets(path: string, label: string): void {
  const raw = loadStateFile(path);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const live = Object.entries(raw).filter(([placeKey]) => !placeKey.includes(":root:"));
  const dropped = Object.keys(raw).length - live.length;
  if (dropped === 0) return;
  log.info(`${label} dropped ${dropped} context bucket(s) with a retired key shape`);
  try {
    saveStateFile(path, Object.fromEntries(live));
  } catch (error) {
    log.warn(`${label} could not rewrite ${path} after dropping retired buckets: ${String(error)}`);
  }
}

export function createFeishuContextBuffer(path: string, label: string): FeishuContextBuffer {
  dropRetiredBuckets(path, label);
  return createGenericContextBuffer({
    path,
    label,
    isEntry,
    line: bufferLine,
  });
}
