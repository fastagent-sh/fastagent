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
 * The directory's containment is PROVED on the result rather than enumerated on the input: `resolve`
 * settles every spelling of escape (`..`, `a/../..`, an absolute path, a Windows drive-relative one)
 * in a single check, so no list of dangerous characters has to be kept complete.
 */
import { resolve, sep } from "node:path";

/** Resolved attachment destination. Throws if `conversationId` names anything outside `filesDir`. */
export function attachmentPath(
  filesDir: string,
  conversationId: string | number,
  fileName: string,
): { dir: string; name: string; path: string } {
  const root = resolve(filesDir);
  const dir = resolve(root, String(conversationId));
  if (!dir.startsWith(root + sep))
    throw new Error(
      `route named an attachment directory outside ${filesDir}: ${JSON.stringify(String(conversationId))}`,
    );

  // A segment can only leave `dir` by holding a separator or by BEING a directory reference, and that
  // is the whole list — which is why the name needs no containment check of its own.
  const cleaned = fileName.replace(/[/\\]/g, "_");
  const name = cleaned === "" || cleaned === "." || cleaned === ".." ? "file" : cleaned;
  return { dir, name, path: resolve(dir, name) };
}
