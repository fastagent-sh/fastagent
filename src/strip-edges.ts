/**
 * Text without the characters at its ends that `isEdge` names, found by index. A regex for it (`/^-+|-+$/`, `/\/+$/`)
 * backtracks quadratically on a long run that is not at the end, and what is trimmed here is often a name or a URL
 * somebody else wrote.
 */
export function stripEdges(text: string, isEdge: (char: string) => boolean): string {
  let start = 0;
  while (start < text.length && isEdge(text[start] as string)) start++;
  return stripEnd(text.slice(start), isEdge);
}

/** `text` without the characters at its end that `isEdge` names. */
export function stripEnd(text: string, isEdge: (char: string) => boolean): string {
  let end = text.length;
  while (end > 0 && isEdge(text[end - 1] as string)) end--;
  return text.slice(0, end);
}

/** A URL or path without the `/` that ends it. */
export function stripTrailingSlashes(text: string): string {
  return stripEnd(text, (char) => char === "/");
}
