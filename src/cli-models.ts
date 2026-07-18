/**
 * CLI presenter for the model-facing commands: `fastagent models [search]` output and the first-run
 * picker's option list. Output DECISIONS live here, out of the engine config layer (config.ts owns
 * model resolution / listModels), so this process-boundary behavior is unit-testable without
 * spawning the CLI.
 */
import { providerOf } from "./engines/pi/config.ts";
import type { InteractiveLoginKind } from "./engines/pi/login.ts";
import type { ProviderAuthStatus } from "./engines/pi/models.ts";

/** One first-run picker entry (@clack/prompts option shape). */
export interface ModelPickerOption {
  value: string;
  label: string;
  hint: string;
}

/** The remedy hint for a non-ready provider, by what picking it actually does: an OAuth flow →
 *  "login required"; an interactive key prompt → "API key required"; no flow at all → the env var. */
function remedy(login: InteractiveLoginKind): string {
  if (login === "oauth") return "login required";
  return login === "api_key" ? "API key required" : "API key required — set the provider's env var";
}

/**
 * The first-run picker menu: the FULL model catalog, each spec annotated with its provider's auth
 * status — ready first (usable now, with the credential source so "which account pays" is visible at
 * the decision point), then the rest with their remedy. Order within each group preserves `specs`
 * (sorted by the caller). A broken provider (expired/corrupt credential) is annotated, not dropped —
 * fail visibly.
 */
export function buildModelPickerOptions(
  specs: string[],
  statuses: Map<string, ProviderAuthStatus>,
): ModelPickerOption[] {
  const ready: ModelPickerOption[] = [];
  const rest: ModelPickerOption[] = [];
  for (const spec of specs) {
    const status = statuses.get(providerOf(spec));
    if (status?.state === "ready") {
      ready.push({ value: spec, label: spec, hint: status.source ? `ready — ${status.source}` : "ready" });
    } else if (status?.state === "broken") {
      // A broken stored credential OWNS the provider (env is consulted only when nothing is stored),
      // so with no login flow the remedy is fixing the store — not the env var (which can't win here).
      rest.push({
        value: spec,
        label: spec,
        hint:
          status.login === "none"
            ? `stored auth unusable: ${status.message} — fix or remove the stored credential`
            : `${remedy(status.login)} — stored auth unusable: ${status.message}`,
      });
    } else if (status) {
      rest.push({ value: spec, label: spec, hint: remedy(status.login) });
    } else {
      // Unreachable when `specs` and `statuses` come from the same Models (every listed provider is
      // probed); if a caller ever mixes sources, promise nothing — neutral wording, no login claim.
      rest.push({ value: spec, label: spec, hint: "auth required" });
    }
  }
  return [...ready, ...rest];
}

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
  const providerMatch = (spec: string) => providerOf(spec).toLowerCase().includes(q);
  return { lines: [...matches.filter(providerMatch), ...matches.filter((s) => !providerMatch(s))] };
}
