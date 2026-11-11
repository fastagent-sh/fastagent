/** Telegram's half of the shared context buffer (mechanics + consume protocol: ../kit/context-buffer.ts). */
import { truncateCodePointPrefix } from "../kit/text.ts";
import {
  capBufferedRefs,
  type ContextBuffer as GenericContextBuffer,
  createContextBuffer as createGenericContextBuffer,
} from "../kit/context-buffer.ts";

/** One buffered un-summoned message, or one the agent sent itself. */
export interface BufferEntry {
  sender: string;
  body: string;
  /** The message's id: rendered into the fold so the model can correlate replies. */
  messageId: number;
  /**
   * Where it stands in its chat, for the range a turn folds: the message id, except for the agent's answer, which stands
   * after the newest message taken when it was done (its own id is from when it began, as a preview).
   */
  at?: number;
  /** The message_id this one replied to, when it was a reply. */
  replyTo?: number;
  /** file_ids of document/voice/video/audio attachments (downloadable on a later summon). */
  fileIds?: string[];
  /** file_ids of photos (usable as vision inputs on a later summon). */
  imageIds?: string[];
  /** The conversation whose turn posted it, when it is the agent's answer: that session holds it already. */
  conversation?: string;
}

/**
 * A buffered attachment reference: its file_id plus WHO posted it in WHICH message, so the manifest can attribute it
 * ("the file Bob sent") the way the fold attributes text.
 */
export interface BufferedRef {
  id: string;
  from: string;
  msg?: number;
}

function bufferLine(e: BufferEntry): string {
  const meta = [`msg ${e.messageId}`, e.replyTo !== undefined ? `reply to msg ${e.replyTo}` : undefined]
    .filter(Boolean)
    .join(", ");
  return `${e.sender}${meta ? ` (${meta})` : ""}: ${e.body}`;
}

/** The buffered attachment references a summoned turn pulls in with the fold. */
export function collectAttachments(
  folded: BufferEntry[],
  primary: { files: Set<string>; images: Set<string> },
): { files: BufferedRef[]; images: BufferedRef[]; skipped: number } {
  const refs = (pick: (e: BufferEntry) => string[] | undefined, exclude: Set<string>): BufferedRef[] => {
    const seen = new Set<string>();
    const out: BufferedRef[] = [];
    for (const e of folded) {
      for (const id of pick(e) ?? []) {
        if (exclude.has(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, from: e.sender, msg: e.messageId });
      }
    }
    return out;
  };
  const files = capBufferedRefs(refs((e) => e.fileIds, primary.files));
  const images = capBufferedRefs(refs((e) => e.imageIds, primary.images));
  return { files: files.kept, images: images.kept, skipped: files.skipped + images.skipped };
}

/**
 * How much of a message the agent sent itself a place keeps. A digest runs to thousands of characters, and the
 * per-line bound a human message gets would keep its title only; this stays inside the buffer's budget, so later
 * discussion still evicts it oldest-first.
 */
const OWN_POST_MAX_CHARS = 2000;

/**
 * A message the agent sent itself (through `telegramTransport`), as the place's discussion: the agent never receives
 * its own messages as updates (and the Bot API has no history read), so this is the only way the chat's next turn
 * knows it was said. The label says only what the transport knows — the agent sent it — not which tool did.
 */
export function ownPostEntry(body: string, messageId: number, conversation?: string, at?: number): BufferEntry {
  return {
    ...(at === undefined ? {} : { at }),
    ...(conversation === undefined ? {} : { conversation }),
    sender: "you (sent by the agent)",
    body: truncateCodePointPrefix(body.replace(/\s+/g, " ").trim(), OWN_POST_MAX_CHARS, " … (truncated)"),
    messageId,
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
    typeof t.messageId === "number" &&
    (t.at === undefined || typeof t.at === "number") &&
    (t.replyTo === undefined || typeof t.replyTo === "number") &&
    strings(t.fileIds) &&
    strings(t.imageIds) &&
    (t.conversation === undefined || typeof t.conversation === "string")
  );
}

export function createContextBuffer(path: string): ContextBuffer {
  return createGenericContextBuffer({
    path,
    label: "[telegram]",
    isEntry: isBufferEntry,
    line: bufferLine,
    position: (entry) => entry.at ?? entry.messageId,
    later: (entry) => entry.at !== undefined,
  });
}
