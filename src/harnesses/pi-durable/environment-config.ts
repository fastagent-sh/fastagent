import type { InstanceConfigSource } from "./config.ts";

/**
 * What a set of variables says of the configuration, one layer per variable so a value's source names it:
 * `FASTAGENT_THINKING_LEVEL`, `FASTAGENT_HTTP_API` (`true` or `false`), `FASTAGENT_HTTP_PUBLIC_URL` and
 * `FASTAGENT_INGRESS` (`channel=webhook|connection`, comma-separated). An empty variable is unset.
 *
 * Only the CLI reads these, for what it runs or delivers; `openAgent` is given its inputs.
 */
export function environmentConfig(env: Readonly<Record<string, string | undefined>>): InstanceConfigSource[] {
  const layers: InstanceConfigSource[] = [];
  const read = (name: string, values: (value: string) => unknown) => {
    const value = env[name];
    if (value !== undefined && value !== "") {
      layers.push({ values: values(value), label: name });
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
