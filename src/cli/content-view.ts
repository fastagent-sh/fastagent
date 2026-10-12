/** How the CLI writes an agent's content. */
import type { BoundContent } from "../content/declare.ts";
import { LOCAL_CONTEXT_FILE } from "../paths.ts";
import { type ResolvedContent, absentNotice } from "../content/resolve.ts";

/** What a content entry is, in the words the reports use. */
function contentKind(c: ResolvedContent): string {
  if (c.kind !== "github") return `this machine only, bound in ${LOCAL_CONTEXT_FILE}`;
  const github = `github ${c.repo}${c.ref ? `@${c.ref}` : ""}`;
  const from = c.context !== undefined ? `, from the context ${c.context}` : "";
  return c.clone
    ? `${github}, a clone brought up to date at each start${from}`
    : `${github}, your checkout bound here${from}`;
}

/**
 * The report lines for an agent's content — `works on` / `knows`, one per entry, then a `notice` line for each
 * thing its resolution has to say, then one for each directory this machine binds that is not here — shared by the
 * startup report, `info` and `content list`, so the three say the same thing.
 */
export function contentLines(
  content: readonly ResolvedContent[],
  absent: readonly BoundContent[] = [],
): [label: string, value: string][] {
  const lines = content.flatMap((c): [string, string][] => [
    [c.readonly ? "knows" : "works on", `${c.name.padEnd(width(content))}  ${c.location} (${contentKind(c)})`],
    ...c.notices.map((notice): [string, string] => ["notice", `${c.name}: ${notice}`]),
  ]);
  for (const binding of absent) lines.push(["notice", absentNotice(binding)]);
  return lines.length === 0 ? [["content", "(none)"]] : lines;
}

function width(content: readonly ResolvedContent[]): number {
  return Math.max(0, ...content.map((c) => c.name.length));
}
