/**
 * CLI presenter for the model-facing commands: `fastagent models [search]` output and the first-run picker's option
 * list.
 */
import { providerOf } from "../engines/pi/config.ts";
import type { InteractiveLoginKind } from "../engines/pi/login.ts";
import type { ProviderAuthStatus } from "../engines/pi/models.ts";

/** One first-run picker entry (@clack/prompts option shape). */
export interface ModelPickerOption {
  value: string;
  label: string;
  hint: string;
}

/** The remedy hint for a non-ready provider, by what picking it actually does. */
function remedy(login: InteractiveLoginKind): string {
  if (login === "oauth") return "login required";
  return login === "api_key" ? "API key required" : "API key required — set the provider's env var";
}

/** The first-run picker menu: the FULL model catalog, each spec annotated with its provider's auth status. */
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
      // A broken stored credential OWNS the provider (env is consulted only when nothing is stored), so with no login
      // flow the remedy is fixing the store.
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
      // Unreachable when `specs` and `statuses` come from the same Models (every listed provider is probed); if a
      // caller ever mixes sources, promise nothing.
      rest.push({ value: spec, label: spec, hint: "auth required" });
    }
  }
  return [...ready, ...rest];
}

export function formatModelsCommand(specs: string[], search?: string): { lines: string[]; error?: string } {
  if (!search) return { lines: specs };
  const q = search.toLowerCase();
  const matches = specs.filter((spec) => spec.toLowerCase().includes(q));
  if (matches.length === 0) return { lines: matches, error: `no model matches "${search}"` };
  // Rank a PROVIDER-name match (query in the part before "/") above an incidental model-id match, so `models
  // anthropic` leads with anthropic/* rather than burying it under amazon-bedrock/anthropic.* and
  // google-vertex/…-anthropic-… (which only match in the model id).
  const providerMatch = (spec: string) => providerOf(spec).toLowerCase().includes(q);
  return { lines: [...matches.filter(providerMatch), ...matches.filter((s) => !providerMatch(s))] };
}
