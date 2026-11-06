/**
 * A deployment's Agent API (SPEC.md §9.5, §9.6): served under `/v1` on every host but AgentCore, unless the
 * definition turns it off (`http.api: false`), behind a key the deploy mints and sets on the target the first time
 * neither the target nor the production value file has one. And what a deploy reports of it.
 */
import { randomBytes } from "node:crypto";
import type { EffectiveConfig } from "../harnesses/pi-durable/config.ts";
import { API_PREFIX } from "../http/contract.ts";
import { API_KEY_VARIABLE, API_TURNED_OFF, apiTurnedOff } from "../http/server.ts";

/** Whether the deployment serves the API, and why not when it does not. */
export type DeploymentApi = { served: true } | { served: false; why: string };

/**
 * Decide the API for one deploy, writing nothing. Turned off, it is off on the deployment too, a key the target still
 * holds included: the serve reads the same setting.
 */
export function deploymentApi(input: {
  config: EffectiveConfig;
  /** The host serves the API at all: not AgentCore, reached only through `/invocations`. */
  hostServes: boolean;
}): DeploymentApi {
  const { config, hostServes } = input;
  if (!hostServes) return { served: false, why: "this host reaches the agent only through its own invocations" };
  if (apiTurnedOff(config)) return { served: false, why: API_TURNED_OFF };
  return { served: true };
}

/** A key for the Agent API, made here: FastAgent mints it, so no person holds it before the deploy. */
export function mintApiKey(): { name: string; make(): string } {
  return { name: API_KEY_VARIABLE, make: () => randomBytes(32).toString("base64url") };
}

/**
 * What a deploy says of the API, once the host has said where the deployment is reached (when it knows). The check
 * names the agent's directory when the command runs elsewhere, since that is where `invoke --url` finds the key.
 * `keyInFile`: this machine's production value file holds a key, which `invoke --url` then reads. `run`: the deploy
 * has set the key (or found one) on the target; without it, nothing was set.
 */
export function apiReport(
  api: DeploymentApi,
  where: { valueFile: string; agentArg: string | undefined; keyInFile: boolean; run: boolean },
  reachedAt: string | undefined,
): string[] {
  if (!api.served) return [`Agent API: not served — ${api.why}`];
  const { valueFile, agentArg, keyInFile, run } = where;
  const base = reachedAt ?? "<the deployment's URL>";
  if (!keyInFile && !run) {
    return [
      `Agent API: ${base}${API_PREFIX}, behind ${API_KEY_VARIABLE}, which --run makes and sets on the target when ` +
        `neither it nor ${valueFile} has one`,
    ];
  }
  if (!keyInFile) {
    return [
      `Agent API: ${base}${API_PREFIX}, behind ${API_KEY_VARIABLE} on the target; ${valueFile} holds none, so pass the key ` +
        `to \`fastagent invoke --url\` with --key`,
    ];
  }
  return [
    `Agent API: ${base}${API_PREFIX}, behind ${API_KEY_VARIABLE} (in ${valueFile})`,
    `check it: fastagent invoke --url ${base} "hello"${agentArg === undefined ? "" : ` ${agentArg}`}`,
  ];
}
