/**
 * CLI presenter for `fastagent models [search]`: the stdout/stderr output DECISION, kept out of the
 * engine config layer (config.ts owns model resolution / listModels) so this process-boundary behavior
 * is unit-testable without spawning the CLI.
 */

/** The output of `fastagent models [search]`: the spec `lines` to print to stdout (a case-insensitive
 *  substring filter; no search → all), and an stderr `error` diagnostic when a search matches nothing. */
export function formatModelsCommand(specs: string[], search?: string): { lines: string[]; error?: string } {
  if (!search) return { lines: specs };
  const q = search.toLowerCase();
  const lines = specs.filter((spec) => spec.toLowerCase().includes(q));
  return lines.length === 0 ? { lines, error: `no model matches "${search}"` } : { lines };
}
