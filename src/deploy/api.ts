/**
 * A deployment's Agent API (agent-api.md §9.5, §9.6): served under `/v1` on every host but AgentCore, unless the
 * definition turns it off (`http.api: false`), behind a key `deploy` generates into the value file the first time,
 * which then travels with every other value. And what a deploy reports of it.
 */
import { randomBytes } from "node:crypto";
import type { AgentConfig } from "../harnesses/pi-durable/define.ts";
import { API_PREFIX } from "../http/contract.ts";
import { API_KEY_VARIABLE, API_TURNED_OFF, apiKeysFrom, apiTurnedOff } from "../http/server.ts";
import { writeValues } from "../value-file.ts";

/** Whether the deployment serves the API (and whether this deploy gives it its key), and why not when it does not. */
export type DeploymentApi = { served: true; generatesKey: boolean } | { served: false; why: string };

/**
 * Decide the API for one deploy, writing nothing: a deploy refused later must leave the value file as it was. Turned
 * off, it is off on the deployment too, a key the values or the host still hold included: the serve reads the same
 * setting.
 */
export function deploymentApi(input: {
  config: AgentConfig;
  /** The host serves the API at all: not AgentCore, reached only through `/invocations`. */
  hostServes: boolean;
  values: ReadonlyMap<string, string>;
}): DeploymentApi {
  const { config, hostServes, values } = input;
  if (!hostServes) return { served: false, why: "this host reaches the agent only through its own invocations" };
  if (apiTurnedOff(config)) return { served: false, why: API_TURNED_OFF };
  return { served: true, generatesKey: apiKeysFrom(values.get(API_KEY_VARIABLE)).length === 0 };
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

/**
 * What a deploy says of the API, once the host has said where the deployment is reached (when it knows). The check
 * names the agent's directory when the command runs elsewhere, since that is where `invoke --url` finds the key.
 */
export function apiReport(
  api: DeploymentApi,
  where: { valueFile: string; agentArg: string | undefined },
  reachedAt: string | undefined,
): string[] {
  if (!api.served) return [`Agent API: not served — ${api.why}`];
  const { valueFile, agentArg } = where;
  const base = reachedAt ?? "<the deployment's URL>";
  return [
    ...(api.generatesKey
      ? [`Agent API: generated ${API_KEY_VARIABLE} in ${valueFile}; it travels with the other values`]
      : []),
    `Agent API: ${base}${API_PREFIX}, behind ${API_KEY_VARIABLE} in ${valueFile}`,
    `check it: fastagent invoke --url ${base} "hello"${agentArg === undefined ? "" : ` ${agentArg}`}`,
  ];
}
