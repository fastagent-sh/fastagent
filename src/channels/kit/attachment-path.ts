/** Where an inbound attachment lands: `<filesDir>/<conversation>/<file>`. */
import { resolve, sep } from "node:path";

export function attachmentPath(
  filesDir: string,
  conversationId: string | number,
  fileName: string,
): { dir: string; name: string; path: string } {
  // A lone surrogate makes `encodeURIComponent` throw `URIError`, and this function rejecting an id is the one thing
  // it must not do.
  const id = String(conversationId).replace(/\p{Surrogate}/gu, "\uFFFD");
  const dir = resolve(filesDir, `c-${encodeURIComponent(id)}`);
  // The name keeps its own check because it is NOT encoded: separators go, and `resolve` settles whether what is left
  // (`..`, a Windows `D:foo`) still lands in `dir`.
  const cleaned = fileName.replace(/[/\\]/g, "_");
  const name = resolve(dir, cleaned).startsWith(dir + sep) ? cleaned : "file";
  return { dir, name, path: resolve(dir, name) };
}
