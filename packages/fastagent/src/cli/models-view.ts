/**
 * CLI presenter for the model-facing commands: `fastagent models [search]` output and the first-run picker's option
 * list.
 */
import { type InteractiveLoginKind, type ProviderAuthStatus, providerOf } from "../harnesses/models/models.ts";

/** One first-run picker entry (@clack/prompts option shape). */
export interface ModelPickerOption {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

/** The remedy hint for a non-ready provider, by what picking it actually does. */
function remedy(login: InteractiveLoginKind): string {
  if (login === "oauth") return "login required";
  return login === "api_key" ? "API key required" : "API key required — set the provider's env var";
}

function hintFor(status: ProviderAuthStatus | undefined): string {
  if (status === undefined) return "auth required";
  if (status.state === "ready") return status.source ? `ready — ${status.source}` : "ready";
  if (status.state === "broken") {
    // A broken stored credential OWNS the provider (env is consulted only when nothing is stored), so with no login
    // flow the remedy is fixing the store.
    return status.login === "none"
      ? `stored auth unusable: ${status.message} — fix or remove the stored credential`
      : `${remedy(status.login)} — stored auth unusable: ${status.message}`;
  }
  return remedy(status.login);
}

/** The first-run picker menu: the FULL model catalog, each spec annotated with its provider's auth status. */
export function buildModelPickerOptions(
  specs: readonly string[],
  statuses: ReadonlyMap<string, ProviderAuthStatus>,
): ModelPickerOption[] {
  const grouped = Map.groupBy(specs, (spec) => statuses.get(providerOf(spec))?.state === "ready");
  const toOption = (spec: string): ModelPickerOption => ({
    value: spec,
    label: spec,
    hint: hintFor(statuses.get(providerOf(spec))),
  });
  return [...(grouped.get(true) ?? []), ...(grouped.get(false) ?? [])].map(toOption);
}

export function formatModelsCommand(specs: readonly string[], search?: string): { lines: string[]; error?: string } {
  if (!search) return { lines: [...specs] };
  const q = search.toLowerCase();
  const matches = specs.filter((spec) => spec.toLowerCase().includes(q));
  if (matches.length === 0) return { lines: matches, error: `no model matches "${search}"` };
  // Rank a PROVIDER-name match (query in the part before "/") above an incidental model-id match, so `models
  // anthropic` leads with anthropic/* rather than burying it under amazon-bedrock/anthropic.* and
  // google-vertex/…-anthropic-… (which only match in the model id).
  const grouped = Map.groupBy(matches, (spec) => providerOf(spec).toLowerCase().includes(q));
  return { lines: [...(grouped.get(true) ?? []), ...(grouped.get(false) ?? [])] };
}
