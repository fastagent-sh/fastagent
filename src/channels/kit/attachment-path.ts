/**
 * Where an inbound attachment lands: `<filesDir>/<conversation>/<file>`.
 *
 * Both halves come from outside the channel, and they are NOT the same question:
 *
 * - The conversation directory is whatever the author's `route` returned. A `../..` there is a bug in
 *   THEIR code, so it is audible — a silent fold into `__..` writes the file somewhere they did not
 *   ask for and tells no one.
 * - The file name comes off the platform, where an odd character is ordinary traffic. Failing a turn
 *   over one would be the channel's bug, so it is reduced to something usable instead.
 *
 * Both are PROVED on the result rather than enumerated on the input: `resolve` settles every spelling
 * of escape (`..`, `a/../..`, an absolute path, a Windows drive-relative `D:foo`) in one check, so no
 * list of dangerous spellings has to be kept complete. They differ only in what a failure means — the
 * directory throws, the name falls back.
 */
import { resolve, sep } from "node:path";

/** Resolved attachment destination. Throws unless `conversationId` names a directory inside `filesDir`. */
export function attachmentPath(
  filesDir: string,
  conversationId: string | number,
  fileName: string,
): { dir: string; name: string; path: string } {
  const root = resolve(filesDir);
  const dir = resolve(root, String(conversationId));
  // `dir === root` when the id is empty or `.`, which is a route that forgot to name a conversation
  // rather than one escaping — same rejection, so the wording has to cover both.
  if (!dir.startsWith(root + sep))
    throw new Error(
      `route named an attachment directory that is not inside ${filesDir}: ${JSON.stringify(String(conversationId))}`,
    );

  const cleaned = fileName.replace(/[/\\]/g, "_");
  const name = resolve(dir, cleaned).startsWith(dir + sep) ? cleaned : "file";
  return { dir, name, path: resolve(dir, name) };
}
