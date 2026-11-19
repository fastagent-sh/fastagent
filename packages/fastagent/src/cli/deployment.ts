/** A served instance elsewhere, as `--url` names it: its Agent API, called with the key this command has for it. */
import { resolve } from "node:path";
import type { Agent } from "@fastagent-sh/client/agent-api";
import { connectAgent } from "@fastagent-sh/client";
import { applyEnvValues, enterAgentEnv } from "../env.ts";
import { API_KEY_VARIABLE, apiKeysFrom } from "../http/server.ts";
import { installProxyFetch } from "../proxy.ts";
import { loadEnvValues, valueFileOf } from "../value-file.ts";
import { failUsage, optionalAgentDirOrExit } from "./fail.ts";
import { type InstanceFlags, enterEnvFile } from "./instance.ts";

/**
 * The Agent API at `url`: nothing opens here, so a flag that places an instance is refused. A deployment has no default
 * value file: the key is `--key`, the environment, or the file `--env-file` names.
 */
export function deploymentAgent(dirArg: string, url: string, key: string | undefined, instance?: InstanceFlags): Agent {
  const { envFile, ...placed } = instance ?? {};
  for (const flag of Object.keys(placed))
    failUsage(`--${flag} places an instance this run opens, and --url opens none`);
  enterEnvFile(envFile, { defaultFile: false });
  return connectAgent(url, { apiKey: enterForUrl(dirArg, key, url) });
}

/**
 * The key `--url` calls with: `--key`, or the first of `FASTAGENT_API_KEY` in this command's environment (the file
 * `--env-file` names laid under it). A deployment has no default file.
 */
function deploymentKey(url: string): string {
  const [key] = apiKeysFrom(process.env[API_KEY_VARIABLE]);
  if (key === undefined) {
    failUsage(
      `no key to call ${url} with: pass --key, or set ${API_KEY_VARIABLE} in the environment of this command ` +
        "(or in the file --env-file names)",
    );
  }
  return key;
}

/**
 * Enter this machine's environment and the proxy it declares, as every command that sends a request does, and answer
 * the key to call `url` with: `--key`, from anywhere (the ambient environment when no agent is here), or the agent's.
 */
function enterForUrl(dirArg: string, key: string | undefined, url: string): string {
  const target = resolve(dirArg);
  const agentDir = optionalAgentDirOrExit(target);
  if (agentDir === undefined) {
    // No agent directory here: honor an explicit --env-file and the ambient environment (e.g. FASTAGENT_API_KEY).
    const file = valueFileOf(target);
    if (file !== undefined) applyEnvValues(loadEnvValues(file));
    installProxyFetch();
    return key ?? deploymentKey(url);
  }
  enterAgentEnv(agentDir);
  return key ?? deploymentKey(url);
}
