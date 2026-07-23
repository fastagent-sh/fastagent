/**
 * Telegram's half of the shared context buffer (mechanics + consume protocol: ../context-buffer.ts):
 * the entry shape, its fold-line rendering, and buffered-attachment selection. Bucketed by Telegram
 * "place" (chat[:thread]), not session: an un-summoned message has no route session, and the flush
 * feeds whatever turn answers that place.
 */
import {
  BUFFER_ATTACH_MAX,
  type ContextBuffer as GenericContextBuffer,
  createContextBuffer as createGenericContextBuffer,
} from "../context-buffer.ts";

/** One buffered un-summoned message (object identity is the commit key). Besides the sender label and
 *  one-line body, it carries what a LATER summon needs to resolve references into the discussion:
 *  message ids ("reply to the one Alex answered"), and attachment file_ids so "summarize the file from
 *  earlier" can actually open it — an un-summoned attachment otherwise surfaces only as its caption or
 *  a `[document: …]` label, never the bytes. */
export interface BufferEntry {
  sender: string;
  body: string;
  /** The message's id — rendered into the fold so the model can correlate replies. */
  messageId?: number;
  /** The message_id this one replied to, when it was a reply. */
  replyTo?: number;
  /** file_ids of document/voice/video/audio attachments (downloadable on a later summon). */
  fileIds?: string[];
  /** file_ids of photos (usable as vision inputs on a later summon). */
  imageIds?: string[];
}

/** A buffered attachment reference: its file_id plus WHO posted it in WHICH message, so the manifest
 *  can attribute it ("the file Bob sent") the way the fold attributes text. */
export interface BufferedRef {
  id: string;
  from: string;
  msg?: number;
}

function bufferLine(e: BufferEntry): string {
  const meta = [
    e.messageId !== undefined ? `msg ${e.messageId}` : undefined,
    e.replyTo !== undefined ? `reply to msg ${e.replyTo}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return `${e.sender}${meta ? ` (${meta})` : ""}: ${e.body}`;
}

/**
 * The buffered attachment references a summoned turn pulls in with the fold — most recent
 * BUFFER_ATTACH_MAX of each kind, MINUS the summoning message's own ids: replying to a still-buffered
 * attachment puts its file_id in both sets, and without the filter the same file would download twice
 * and appear in the manifest twice (primary wins — it is what the user pointed at this turn).
 * Cap-skipped ones are COUNTED, not silently dropped: a fold line may show a [document: …] label, but
 * a captioned attachment renders as its caption text alone — without a note, the model holds
 * references it silently cannot open and may pretend it read them.
 */
export function collectAttachments(
  consumed: BufferEntry[],
  primary: { files: Set<string>; images: Set<string> },
): { files: BufferedRef[]; images: BufferedRef[]; skipped: number } {
  const refs = (pick: (e: BufferEntry) => string[] | undefined, exclude: Set<string>): BufferedRef[] => {
    const seen = new Set<string>();
    const out: BufferedRef[] = [];
    for (const e of consumed) {
      for (const id of pick(e) ?? []) {
        if (exclude.has(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, from: e.sender, msg: e.messageId });
      }
    }
    return out;
  };
  const files = refs((e) => e.fileIds, primary.files);
  const images = refs((e) => e.imageIds, primary.images);
  return {
    files: files.slice(-BUFFER_ATTACH_MAX),
    images: images.slice(-BUFFER_ATTACH_MAX),
    skipped: Math.max(0, files.length - BUFFER_ATTACH_MAX) + Math.max(0, images.length - BUFFER_ATTACH_MAX),
  };
}

export type ContextBuffer = GenericContextBuffer<BufferEntry>;

function isBufferEntry(e: unknown): e is BufferEntry {
  const t = e as BufferEntry;
  const strings = (v: unknown): boolean =>
    v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  return (
    typeof t?.sender === "string" &&
    typeof t.body === "string" &&
    (t.messageId === undefined || typeof t.messageId === "number") &&
    (t.replyTo === undefined || typeof t.replyTo === "number") &&
    strings(t.fileIds) &&
    strings(t.imageIds)
  );
}

export function createContextBuffer(path: string): ContextBuffer {
  return createGenericContextBuffer({ path, label: "[telegram]", isEntry: isBufferEntry, line: bufferLine });
}
