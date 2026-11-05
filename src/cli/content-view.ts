/** How the CLI writes an agent's content. */
import type { ResolvedContent } from "../content/resolve.ts";

/** What a content entry is, in the words the reports use. */
function contentKind(c: ResolvedContent): string {
  if (c.kind !== "github") return "a directory of this machine";
  return `github ${c.repo}${c.ref ? `@${c.ref}` : ""}, a clone brought up to date at each start`;
}

/**
 * The report lines for an agent's content — `works on`, one per entry, then a `notice` line for each thing its
 * resolution has to say — shared by the startup report, `info` and `content list`, so the three say the same thing.
 */
export function contentLines(content: readonly ResolvedContent[]): [label: string, value: string][] {
  const lines = content.flatMap((c): [string, string][] => [
    ["works on", `${c.name.padEnd(width(content))}  ${c.location} (${contentKind(c)})`],
    ...c.notices.map((notice): [string, string] => ["notice", `${c.name}: ${notice}`]),
  ]);
  return lines.length === 0 ? [["content", "(none)"]] : lines;
}

function width(content: readonly ResolvedContent[]): number {
  return Math.max(0, ...content.map((c) => c.name.length));
}
