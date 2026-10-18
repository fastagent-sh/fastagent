/**
 * Which images a journal entry PUBLISHES, the ref each one is published under, and the read back from a ref. The log
 * record (log-records.ts) and `attachment()` both go through here, so the entry and the byte read cannot disagree
 * about which images exist or what their refs are.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionEntry as PiSessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageRef } from "../../protocol.ts";

/** An image an entry publishes: its ref, for `attachment(ref)`, and its type. */
type EntryImage = { ref: string; mimeType: string };

type Message = { role: string; content?: unknown };

/** A user prompt's and a tool result's images; no other message publishes any, so no ref can reach them. */
function publishedImages(message: Message): ImageContent[] {
  if (message.role !== "user" && message.role !== "toolResult") return [];
  const content = message.content;
  return Array.isArray(content) ? content.filter((b: { type?: unknown }) => b.type === "image") : [];
}

/** `data.images` of the entry `entryId` holding `message`, absent when it has none. */
export function entryImages(entryId: string, message: Message): { images?: EntryImage[] } {
  const images = publishedImages(message).map((b, i) => ({ ref: `${entryId}:${i}`, mimeType: b.mimeType }));
  return images.length > 0 ? { images } : {};
}

/** The entry and the position a ref names, or undefined when it is not one `entryImages` made. */
export function parseImageRef(ref: string): { entryId: string; index: number } | undefined {
  const at = ref.lastIndexOf(":");
  const index = ref.slice(at + 1);
  // Canonical digits only, so one image has one ref (`:00` is not `:0`).
  if (at <= 0 || !/^(0|[1-9]\d*)$/.test(index)) return undefined;
  return { entryId: ref.slice(0, at), index: Number(index) };
}

/** The image a message publishes at `index`. */
export function imageIn(message: Message, index: number): ImageRef | undefined {
  const image = publishedImages(message)[index];
  return image ? { data: image.data, mimeType: image.mimeType } : undefined;
}

/** The image `ref` names in `record`, or undefined when it names none there. The inverse of `entryImages`. */
export function imageAt(record: SessionManager, ref: string): ImageRef | undefined {
  const at = parseImageRef(ref);
  const entry = at && (record.getEntry(at.entryId) as PiSessionEntry | undefined);
  return at && entry?.type === "message" ? imageIn(entry.message, at.index) : undefined;
}
