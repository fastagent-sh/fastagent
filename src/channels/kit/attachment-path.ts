/**
 * Where an inbound attachment lands: `<filesDir>/<conversation>/<file>`.
 *
 * Both halves come from outside the channel, and they are NOT the same question:
 *
 * - The conversation is an id, and turning an arbitrary caller id into a storage name is a job this
 *   repo already answers by ENCODING it, never by rejecting it (`piSessionId` in
 *   engines/pi/session-store.ts, same shape: a character whitelist under a fixed prefix). An id is
 *   the caller's — a route returning `../..` gets an odd directory, not a failed turn, because the
 *   place to notice that id is broken is the reply it cannot deliver, not the disk.
 * - The file name is not an id: it is read by a human and by the model, in a path this puts into the
 *   prompt. Encoding it would cost that, so it is reduced instead — losing the odd character rather
 *   than the readability.
 *
 * The encoding makes containment structural rather than checked: `encodeURIComponent` emits no path
 * separator (`/` → `%2F`, `\` → `%5C`, `:` → `%3A`), and the prefix leaves no way to spell `.`, `..`
 * or the empty string. It is also lossless, so two conversations cannot land in one directory.
 */
import { resolve, sep } from "node:path";

/** Attachment destination for one conversation. Total: every id and name resolves to something. */
export function attachmentPath(
  filesDir: string,
  conversationId: string | number,
  fileName: string,
): { dir: string; name: string; path: string } {
  const dir = resolve(filesDir, `c-${encodeURIComponent(String(conversationId))}`);
  // The name keeps its own check because it is NOT encoded: separators go, and `resolve` settles
  // whether what is left (`..`, a Windows `D:foo`) still lands in `dir`.
  const cleaned = fileName.replace(/[/\\]/g, "_");
  const name = resolve(dir, cleaned).startsWith(dir + sep) ? cleaned : "file";
  return { dir, name, path: resolve(dir, name) };
}
