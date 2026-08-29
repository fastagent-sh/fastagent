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
 *   than the readability. A leading dot survives: `.gitignore` is a name, not an escape, and nothing
 *   lists this directory, so hiding is not a property anyone here depends on.
 *
 * The encoding makes containment structural rather than checked: `encodeURIComponent` emits no path
 * separator (`/` → `%2F`, `\` → `%5C`, `:` → `%3A`), and the prefix leaves no way to spell `.`, `..`
 * or the empty string.
 *
 * It is lossless for a well-formed id, so `a/b` and `a_b` are different places. Two exceptions, both
 * outside what a platform hands over: ids differing only in malformed UTF-16 (see the substitution
 * below), and ids differing only in case on a case-insensitive filesystem.
 */
import { resolve, sep } from "node:path";

/**
 * Attachment destination for one conversation. Never rejects an id — but the path it returns is not
 * promised to be one the filesystem accepts: percent-encoding spends up to 9 bytes per character, so
 * an id of ~29 CJK characters exceeds a 255-byte `NAME_MAX` and the caller's `mkdir` fails with
 * `ENAMETOOLONG`. Left to fail there rather than truncated here: a digest suffix would buy a length
 * no platform id approaches, at the cost of the readability this encoding exists to keep.
 */
export function attachmentPath(
  filesDir: string,
  conversationId: string | number,
  fileName: string,
): { dir: string; name: string; path: string } {
  // A lone surrogate makes `encodeURIComponent` throw `URIError`, and this function rejecting an id
  // is the one thing it must not do — a permanent bad id would surface as a retryable turn failure.
  // The `u` flag matches by code point, so a valid pair (an emoji in a route's id) is left alone.
  const id = String(conversationId).replace(/\p{Surrogate}/gu, "\uFFFD");
  const dir = resolve(filesDir, `c-${encodeURIComponent(id)}`);
  // The name keeps its own check because it is NOT encoded: separators go, and `resolve` settles
  // whether what is left (`..`, a Windows `D:foo`) still lands in `dir`.
  const cleaned = fileName.replace(/[/\\]/g, "_");
  const name = resolve(dir, cleaned).startsWith(dir + sep) ? cleaned : "file";
  return { dir, name, path: resolve(dir, name) };
}
