/** Where an inbound attachment lands: `<stateHome>/files/<conversation>/<file>`. */
import { join, resolve, sep } from "node:path";

/**
 * THE inbound-attachment root inside a channel's state home. One spelling because three channels write here and a
 * conversation id becomes a directory under it; nothing else reads it, and nothing removes it — an attachment is
 * durable conversation data, and this directory grows with the agent's inbound traffic (docs/design/core.md §9).
 */
export const attachmentsDir = (stateHome: string): string => join(stateHome, "files");

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
