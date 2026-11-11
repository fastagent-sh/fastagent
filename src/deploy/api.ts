/**
 * A deployment's Agent API (SPEC.md §9.5, §9.6): served under `/v1` on every host but AgentCore, unless the
 * definition turns it off (`http.api: false`), behind a key the deploy mints and sets on the target the first time
 * neither the target nor the values the deploy was given has one. And what a deploy reports of it.
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

/**
 * The Agent API's key, for a deploy to restore from its values or make. Made only where a person sees it (`canShow`, a
 * terminal): a key made for a CI job or a coding agent's run would be one nobody holds, so there its absence is a gap
 * the person fills with `fastagent secrets set <host> FASTAGENT_API_KEY --generate`.
 */
export function mintApiKey(canShow: boolean): { name: string; hint: string; make?: () => string } {
  return {
    name: API_KEY_VARIABLE,
    hint: "the Agent API's key, made once and shown to the person who makes it",
    ...(canShow ? { make: () => randomBytes(32).toString("base64url") } : {}),
  };
}

/**
 * What a deploy says of the API, once the host has said where the deployment is reached (when it knows). The check
 * names the agent's directory when the command runs elsewhere, since that is where `invoke --url` is run from.
 * `keyHere`: this command's values (its environment, or the file `--env-file` names) hold a key, which `invoke --url`
 * then reads from its own. `run`: the deploy has set the key (or found one) on the target; without it, nothing was set.
 */
export function apiReport(
  api: DeploymentApi,
  where: { valuesFrom: string; agentArg: string | undefined; keyHere: boolean; run: boolean },
  reachedAt: string | undefined,
): string[] {
  if (!api.served) return [`Agent API: not served — ${api.why}`];
  const { valuesFrom, agentArg, keyHere, run } = where;
  const base = reachedAt ?? "<the deployment's URL>";
  if (!keyHere && !run) {
    return [
      `Agent API: ${base}${API_PREFIX}, behind ${API_KEY_VARIABLE}, which --run sets on the target from ${valuesFrom}, ` +
        `or makes at a terminal when neither it nor the target has one`,
    ];
  }
  if (!keyHere) {
    return [
      `Agent API: ${base}${API_PREFIX}, behind ${API_KEY_VARIABLE} on the target; ${valuesFrom} holds none, so pass the ` +
        `key to \`fastagent invoke --url\` with --key`,
    ];
  }
  return [
    `Agent API: ${base}${API_PREFIX}, behind ${API_KEY_VARIABLE} (from ${valuesFrom})`,
    `check it: fastagent invoke --url ${base} "hello"${agentArg === undefined ? "" : ` ${agentArg}`}`,
  ];
}
