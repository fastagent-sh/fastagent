/**
 * A deployment's Agent API (agent-api.md §9.5, §9.6): served under `/v1` on every host but AgentCore, unless the
 * definition says `deploy.api: false`, behind a key `deploy` generates into the value file the first time, which then
 * travels with every other value. And what a deploy reports of it.
 */
import { randomBytes } from "node:crypto";
import type { AgentConfig } from "../harnesses/pi-durable/define.ts";
import { API_PREFIX } from "../http/contract.ts";
import { API_KEY_VARIABLE, apiKeysFrom } from "../http/server.ts";
import { writeValues } from "../value-file.ts";

/** Whether the deployment serves the API (and whether this deploy gives it its key), and why not when it does not. */
export type DeploymentApi = { served: true; generatesKey: boolean } | { served: false; why: string };

/**
 * Decide the API for one deploy, writing nothing: a deploy refused later must leave the value file as it was. A
 * definition that turns the API off while the values still hold a key is refused, since the key would serve it anyway.
 */
export function deploymentApi(input: {
  config: AgentConfig;
  /** The host serves the API at all: not AgentCore, reached only through `/invocations`. */
  hostServes: boolean;
  values: ReadonlyMap<string, string>;
  valueFile: string;
}): DeploymentApi {
  const { config, hostServes, values, valueFile } = input;
  if (!hostServes) return { served: false, why: "this host reaches the agent only through its own invocations" };
  const keys = apiKeysFrom(values.get(API_KEY_VARIABLE));
  if (config.deploy?.api === false) {
    if (keys.length > 0) {
      throw new Error(
        `fastagent.config.ts says deploy.api: false, and ${valueFile} holds ${API_KEY_VARIABLE}, which serves the ` +
          `Agent API all the same: remove the key, or the setting`,
      );
    }
    return { served: false, why: "fastagent.config.ts says deploy.api: false" };
  }
  return { served: true, generatesKey: keys.length === 0 };
}

/** Give the deployment its key: into the value file, from which it travels with the other values. */
export async function writeApiKey(agentDir: string): Promise<void> {
  const key = randomBytes(32).toString("base64url");
  // Named in `overwrite`: a line that holds no key (empty, or only commas) is replaced, not kept as set.
  await writeValues(
    agentDir,
    "Agent API",
    [{ name: API_KEY_VARIABLE, value: key, hint: "The Agent API's keys, comma-separated; deploy generated this one" }],
    [API_KEY_VARIABLE],
  );
}

/** What a deploy says of the API, once the host has said where the deployment is reached (when it knows). */
export function apiReport(api: DeploymentApi, valueFile: string, reachedAt: string | undefined): string[] {
  if (!api.served) return [`Agent API: not served — ${api.why}`];
  const base = reachedAt ?? "<the deployment's URL>";
  return [
    ...(api.generatesKey
      ? [`Agent API: generated ${API_KEY_VARIABLE} in ${valueFile}; it travels with the other values`]
      : []),
    `Agent API: ${base}${API_PREFIX}, behind ${API_KEY_VARIABLE} in ${valueFile}`,
    `check it: fastagent invoke --url ${base} "hello"`,
  ];
}
