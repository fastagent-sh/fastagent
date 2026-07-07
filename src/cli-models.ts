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
  const matches = specs.filter((spec) => spec.toLowerCase().includes(q));
  if (matches.length === 0) return { lines: matches, error: `no model matches "${search}"` };
  // Rank a PROVIDER-name match (query in the part before "/") above an incidental model-id match, so
  // `models anthropic` leads with anthropic/* rather than burying it under amazon-bedrock/anthropic.*
  // and google-vertex/…-anthropic-… (which only match in the model id). Order within each group is kept.
  const providerMatch = (spec: string) => spec.slice(0, spec.indexOf("/")).toLowerCase().includes(q);
  return { lines: [...matches.filter(providerMatch), ...matches.filter((s) => !providerMatch(s))] };
}
