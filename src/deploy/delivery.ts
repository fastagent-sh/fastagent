/**
 * What a deploy delivers to the host besides the image (configuration-layout.md §5): the image holds the program and
 * nothing of an instance, so what varies per deployment is set as variables the host renders by its own mechanism for
 * non-secret values. The box reads them back in `start` (`FASTAGENT_CONFIG_JSON` in harnesses/pi-durable/config.ts,
 * the other two in deploy/workspace.ts).
 */
import { createHash } from "node:crypto";
import { INSTANCE_NAME_ENV } from "../instance-name.ts";
import { INSTANCE_CONFIG_JSON_ENV, RELEASE_ID_ENV } from "../paths.ts";

/**
 * The configuration a deploy delivers, as one line of JSON: the instance configuration `--config` names (none: the
 * program's defaults). Rewritten whole by every deploy, so nothing an earlier one set outlives it.
 */
export function deliveredConfig(values: unknown): string {
  const { $schema: _schema, ...rest } = (values ?? {}) as Record<string, unknown>;
  return JSON.stringify(rest);
}

/**
 * The delivered configuration with the public URL the host gives the box as its `http.publicUrl`, where the operator's
 * configuration names none (a custom domain is theirs to name): the URL the box points its channels at.
 */
export function withPublicUrl(config: string, publicUrl: string): { config: string; publicUrl: string } {
  const own = ownPublicUrl(config);
  if (own !== undefined) return { config, publicUrl: own };
  const values = JSON.parse(config) as { http?: object };
  return { config: JSON.stringify({ ...values, http: { ...values.http, publicUrl } }), publicUrl };
}

/** The `http.publicUrl` an operator's configuration names, if it does. */
export function ownPublicUrl(config: string): string | undefined {
  return (JSON.parse(config) as { http?: { publicUrl?: string } }).http?.publicUrl;
}

/**
 * The variables a deploy sets on the box beside the secrets. The release id is a digest of what the others carry, so a
 * file that holds them (a committed manifest) changes only when the instance's configuration does.
 */
export function deliveredVariables(input: { agent: string; config: string }): Record<string, string> {
  const id = createHash("sha256").update(input.agent).update("\0").update(input.config).digest("hex").slice(0, 12);
  return { [INSTANCE_NAME_ENV]: input.agent, [RELEASE_ID_ENV]: id, [INSTANCE_CONFIG_JSON_ENV]: input.config };
}

/**
 * Why the configuration cannot be delivered as variables, or undefined when it can: a deployment's text is the
 * program's, and an instance adds none of its own on a host.
 */
export function undeliverableText(source: { values: unknown; label: string }): string | undefined {
  const values = (source.values ?? {}) as Record<string, unknown>;
  const kinds = (["instructions", "skills", "prompts"] as const).filter((kind) => values[kind] !== undefined);
  return kinds.length === 0
    ? undefined
    : `${source.label}: ${kinds.join(", ")} name text of this machine, and a deployment's text is the program's: ` +
        `move it into the agent directory (AGENTS.md, SYSTEM.md, skills/, prompts/), which every release carries`;
}
