/** How the CLI writes an agent's contexts. */
import type { ResolvedContext } from "../contexts/resolve.ts";

/** What each kind of context is, in the words the reports use. */
const CONTEXT_KIND: Record<ResolvedContext["kind"], string> = {
  local: "local, this machine only",
  copy: "local, copied to a host",
  github: "github",
};

/**
 * The report lines for an agent's contexts — `works on` / `knows`, one per context — shared by the startup report,
 * `info` and `context list`, so the three say the same thing.
 */
export function contextLines(contexts: readonly ResolvedContext[]): [label: string, value: string][] {
  if (contexts.length === 0) return [["contexts", "(none)"]];
  const width = Math.max(...contexts.map((c) => c.name.length));
  return contexts.map((c) => [
    c.readonly ? "knows" : "works on",
    `${c.name.padEnd(width)}  ${c.location} (${CONTEXT_KIND[c.kind]})`,
  ]);
}
