import type { InstanceConfigSource } from "./config.ts";

/**
 * What the process's environment says of the configuration, one layer per variable so a value's source names it:
 * `FASTAGENT_THINKING_LEVEL`, `FASTAGENT_HTTP_API` (`true` or `false`) and `FASTAGENT_HTTP_PUBLIC_URL`. An empty
 * variable is unset. Only a process that runs an instance from the CLI reads these; `openAgent` is given its inputs.
 */
export function environmentConfig(env: Readonly<Record<string, string | undefined>>): InstanceConfigSource[] {
  const layers: InstanceConfigSource[] = [];
  const read = (name: string, values: (value: string) => unknown) => {
    const value = env[name];
    if (value !== undefined && value !== "") layers.push({ values: values(value), label: name });
  };
  read("FASTAGENT_THINKING_LEVEL", (value) => ({ thinkingLevel: value }));
  read("FASTAGENT_HTTP_API", (value) => {
    if (value !== "true" && value !== "false") {
      throw new Error(`FASTAGENT_HTTP_API must be "true" or "false", and is ${JSON.stringify(value)}`);
    }
    return { http: { api: value === "true" } };
  });
  read("FASTAGENT_HTTP_PUBLIC_URL", (value) => ({ http: { publicUrl: value } }));
  return layers;
}
