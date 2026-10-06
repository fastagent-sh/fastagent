/** How the CLI writes an agent's contexts. */
import type { ResolvedContext } from "../contexts/resolve.ts";

/** What a context is, in the words the reports use. */
function contextKind(c: ResolvedContext): string {
  if (c.kind !== "github") return c.kind === "copy" ? "local, copied to a host" : "local, this machine only";
  const github = `github ${c.repo}${c.ref ? `@${c.ref}` : ""}`;
  return c.clone ? `${github}, a clone brought up to date at each start` : `${github}, this checkout`;
}

/**
 * The report lines for an agent's contexts — `works on` / `knows`, one per context, then a `notice` line for each
 * thing its resolution has to say — shared by the startup report, `info` and `context list`, so the three say the
 * same thing.
 */
export function contextLines(contexts: readonly ResolvedContext[]): [label: string, value: string][] {
  if (contexts.length === 0) return [["contexts", "(none)"]];
  const width = Math.max(...contexts.map((c) => c.name.length));
  return contexts.flatMap((c): [string, string][] => [
    [c.readonly ? "knows" : "works on", `${c.name.padEnd(width)}  ${c.location} (${contextKind(c)})`],
    ...c.notices.map((notice): [string, string] => ["notice", `${c.name}: ${notice}`]),
  ]);
}
