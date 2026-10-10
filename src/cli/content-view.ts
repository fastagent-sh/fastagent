/** How the CLI writes an agent's content. */
import type { ResolvedContent } from "../content/resolve.ts";

/** What a content entry is, in the words the reports use. */
function contentKind(c: ResolvedContent): string {
  if (c.kind !== "github") return "local, this machine only";
  const github = `github ${c.repo}${c.ref ? `@${c.ref}` : ""}`;
  return c.clone ? `${github}, a clone brought up to date at each start` : `${github}, this checkout`;
}

/**
 * The report lines for an agent's content — `works on` / `knows`, one per entry, then a `notice` line for each
 * thing its resolution has to say — shared by the startup report, `info` and `content list`, so the three say the
 * same thing.
 */
export function contentLines(content: readonly ResolvedContent[]): [label: string, value: string][] {
  if (content.length === 0) return [["content", "(none)"]];
  const width = Math.max(...content.map((c) => c.name.length));
  return content.flatMap((c): [string, string][] => [
    [c.readonly ? "knows" : "works on", `${c.name.padEnd(width)}  ${c.location} (${contentKind(c)})`],
    ...c.notices.map((notice): [string, string] => ["notice", `${c.name}: ${notice}`]),
  ]);
}
