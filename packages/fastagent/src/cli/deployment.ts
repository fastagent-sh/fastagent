/**
 * A served instance elsewhere, named either by `--url` or by `--remote <name>` from `~/.config/fastagent/remotes.json`:
 * its Agent API, called with the key or AgentCore credentials configured for it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Agent } from "@fastagent-sh/client/agent-api";
import { connectAgent } from "@fastagent-sh/client";
import { expandRemoteEnvRef, parseRemotesJson } from "@fastagent-sh/client/remotes";
import { applyEnvValues, enterAgentEnv } from "../env.ts";
import { API_KEY_VARIABLE, apiKeysFrom } from "../http/server.ts";
import { installProxyFetch } from "../proxy.ts";
import { loadEnvValues, valueFileOf } from "../value-file.ts";
import { failUsage, optionalAgentDirOrExit } from "./fail.ts";
import { type InstanceFlags, enterEnvFile } from "./instance.ts";

export interface RemoteTargetFlags {
  url?: string;
  key?: string;
  remote?: string;
}

function defaultRemotesPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FASTAGENT_REMOTES_PATH?.trim();
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg || join(homedir(), ".config");
  return join(base, "fastagent", "remotes.json");
}

function rejectPlacedInstance(instance: InstanceFlags | undefined, flagName: string): string | undefined {
  const { envFile, ...placed } = instance ?? {};
  for (const flag of Object.keys(placed)) {
    failUsage(`--${flag} places an instance this run opens, and ${flagName} opens none`);
  }
  return envFile;
}

/**
 * The key `--url` calls with: `--key`, or the first of `FASTAGENT_API_KEY` in this command's environment (the file
 * `--env-file` names laid under it). A deployment has no default file.
 */
function deploymentKey(where: string): string {
  const [key] = apiKeysFrom(process.env[API_KEY_VARIABLE]);
  if (key === undefined) {
    failUsage(
      `no key to call ${where} with: pass --key, or set ${API_KEY_VARIABLE} in the environment of this command ` +
        "(or in the file --env-file names)",
    );
  }
  return key;
}

/**
 * Enter this machine's environment and the proxy it declares, as every command that sends a request does.
 */
function enterRemoteEnvironment(dirArg: string): void {
  const target = resolve(dirArg);
  const agentDir = optionalAgentDirOrExit(target);
  if (agentDir === undefined) {
    const file = valueFileOf(target);
    if (file !== undefined) applyEnvValues(loadEnvValues(file));
    installProxyFetch();
    return;
  }
  enterAgentEnv(agentDir);
}

/**
 * The Agent API for `--url` or `--remote`: nothing opens locally, so flags that place a local instance are refused.
 */
export async function resolveRemoteTarget(
  dirArg: string,
  target: RemoteTargetFlags,
  instance?: InstanceFlags,
): Promise<{ agent: Agent; label: string; defaultSessionId?: string } | undefined> {
  if (target.url !== undefined && target.remote !== undefined) {
    failUsage("pass either --url or --remote, not both");
  }
  if (target.url === undefined && target.remote === undefined) {
    if (target.key !== undefined)
      failUsage("--key is the key --url or --remote calls with: pass --url or --remote too");
    return undefined;
  }

  const flagName = target.remote !== undefined ? "--remote" : "--url";
  const envFile = rejectPlacedInstance(instance, flagName);
  enterEnvFile(envFile, { defaultFile: false });
  enterRemoteEnvironment(dirArg);

  if (target.url !== undefined) {
    const apiKey = target.key ?? deploymentKey(target.url);
    return { agent: connectAgent(target.url, { apiKey }), label: target.url };
  }

  const remoteName = target.remote?.trim();
  if (!remoteName) failUsage("--remote requires a non-empty remote name");
  const remotesPath = defaultRemotesPath();
  if (!existsSync(remotesPath)) {
    failUsage(`--remote ${remoteName}: no remotes config found at ${remotesPath}`);
  }
  let file: ReturnType<typeof parseRemotesJson>;
  try {
    file = parseRemotesJson(readFileSync(remotesPath, "utf8"), remotesPath);
  } catch (error) {
    failUsage(error instanceof Error ? error.message : String(error));
  }
  const entry = file.remotes[remoteName];
  if (!entry) {
    const names = Object.keys(file.remotes);
    const available = names.length > 0 ? ` (configured: ${names.join(", ")})` : " (no remotes configured)";
    failUsage(`--remote ${remoteName}: unknown remote in ${remotesPath}${available}`);
  }

  if (entry.type === "http") {
    let apiKey: string;
    if (target.key !== undefined) {
      apiKey = target.key;
    } else if (entry.apiKey?.trim()) {
      try {
        apiKey = expandRemoteEnvRef(entry.apiKey.trim(), `remotes.${remoteName}.apiKey`, process.env);
      } catch (error) {
        failUsage(error instanceof Error ? error.message : String(error));
      }
    } else {
      apiKey = deploymentKey(entry.url);
    }
    return {
      agent: connectAgent(entry.url, { apiKey }),
      label: `${remoteName} (${entry.url})`,
      ...(entry.sessionId !== undefined ? { defaultSessionId: entry.sessionId } : {}),
    };
  }

  if (target.key !== undefined) {
    failUsage(`--key cannot be used with AgentCore remote "${remoteName}"`);
  }
  let agentcore: typeof import("@fastagent-sh/client/agentcore");
  try {
    agentcore = await import("@fastagent-sh/client/agentcore");
  } catch (error) {
    failUsage(
      `remote "${remoteName}" uses AgentCore; install @aws-sdk/client-bedrock-agentcore (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return {
    agent: agentcore.connectAgentCore({
      runtimeArn: entry.runtimeArn,
      sessionId: entry.sessionId,
      ...(entry.qualifier !== undefined ? { qualifier: entry.qualifier } : {}),
    }),
    label: `${remoteName} (${entry.runtimeArn})`,
  };
}
