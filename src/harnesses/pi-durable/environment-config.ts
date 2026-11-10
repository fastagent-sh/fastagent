import type { InstanceConfigSource } from "./config.ts";

/**
 * What a set of variables says of the configuration, one layer per variable so a value's source names it:
 * `FASTAGENT_THINKING_LEVEL`, `FASTAGENT_HTTP_API` (`true` or `false`), `FASTAGENT_HTTP_PUBLIC_URL` and
 * `FASTAGENT_INGRESS` (`channel=webhook|connection`, comma-separated). An empty variable is unset. `where` says what
 * held them when it is not this process's environment (a value file), and is part of each source.
 *
 * Only the CLI reads these, for what it runs or delivers; `openAgent` is given its inputs.
 */
export function environmentConfig(
  env: Readonly<Record<string, string | undefined>>,
  where?: string,
): InstanceConfigSource[] {
  const layers: InstanceConfigSource[] = [];
  const read = (name: string, values: (value: string) => unknown) => {
    const value = env[name];
    if (value !== undefined && value !== "") {
      layers.push({ values: values(value), label: where === undefined ? name : `${name} in ${where}` });
    }
  };
  read("FASTAGENT_THINKING_LEVEL", (value) => ({ thinkingLevel: value }));
  read("FASTAGENT_HTTP_API", (value) => {
    if (value !== "true" && value !== "false") {
      throw new Error(`FASTAGENT_HTTP_API must be "true" or "false", and is ${JSON.stringify(value)}`);
    }
    return { http: { api: value === "true" } };
  });
  read("FASTAGENT_HTTP_PUBLIC_URL", (value) => ({ http: { publicUrl: value } }));
  read("FASTAGENT_INGRESS", (value) => {
    const channels: Record<string, { ingress: string }> = {};
    for (const item of value.split(",")) {
      const [channel, ingress, ...rest] = item.split("=").map((part) => part.trim());
      if (!channel || !ingress || rest.length > 0) {
        throw new Error(
          `FASTAGENT_INGRESS must be channel=webhook|connection, comma-separated, and is ${JSON.stringify(value)}`,
        );
      }
      channels[channel] = { ingress };
    }
    return { channels };
  });
  return layers;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `layer` over `into`: objects merge, anything else replaces. */
function merge(into: Record<string, unknown>, layer: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...into };
  for (const [key, value] of Object.entries(layer)) {
    const held = merged[key];
    merged[key] = isRecord(value) && isRecord(held) ? merge(held, value) : value;
  }
  return merged;
}

/**
 * A configuration's text with `layers` laid over it, what a deploy delivers so the box runs the values the deploy
 * decided with. No layer leaves it as it is, `undefined` (none delivered) included.
 */
export function foldLayers(text: string | undefined, layers: readonly InstanceConfigSource[]): string | undefined {
  if (layers.length === 0) return text;
  let values = (text === undefined ? {} : JSON.parse(text)) as Record<string, unknown>;
  for (const layer of layers) values = merge(values, layer.values as Record<string, unknown>);
  return `${JSON.stringify(values, null, 2)}\n`;
}
