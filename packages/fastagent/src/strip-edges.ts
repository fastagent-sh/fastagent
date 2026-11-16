/**
 * Text without the characters at its ends that `isEdge` names, found by index. A regex for it (`/^-+|-+$/`, `/\/+$/`)
 * backtracks quadratically on a long run that is not at the end, and what is trimmed here is often a name or a URL
 * somebody else wrote.
 */
export function stripEdges(text: string, isEdge: (char: string) => boolean): string {
  let start = 0;
  while (start < text.length && isEdge(text[start] as string)) start++;
  let end = text.length;
  while (end > start && isEdge(text[end - 1] as string)) end--;
  return text.slice(start, end);
}
