/**
 * A served instance elsewhere, named either by `--url` or by `--remote <name>` from `~/.config/fastagent/remotes.json`:
 * its Agent API, over HTTP or any installed `@fastagent-sh/client-<type>` transport package.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuthApi, RemoteAgent } from "@fastagent-sh/client/agent-api";
import { connectAgent, connectAuth } from "@fastagent-sh/client";
import {
  connectExtensionRemote,
  expandRemoteEnvRef,
  isHttpRemote,
  parseRemotesJson,
} from "@fastagent-sh/client/remotes";
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
): Promise<{ agent: RemoteAgent; auth: AuthApi; label: string; defaultSessionId?: string } | undefined> {
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
    return {
      agent: connectAgent(target.url, { apiKey }),
      auth: connectAuth(target.url, { apiKey }),
      label: target.url,
    };
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

  if (isHttpRemote(entry)) {
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
      auth: connectAuth(entry.url, { apiKey }),
      label: `${remoteName} (${entry.url})`,
      ...(entry.sessionId !== undefined ? { defaultSessionId: entry.sessionId } : {}),
    };
  }

  const cwd = resolve(dirArg);
  const loadModule = async (specifier: string): Promise<unknown> => {
    try {
      const resolved = createRequire(join(cwd, "package.json")).resolve(specifier);
      return await import(pathToFileURL(resolved).href);
    } catch {
      return await import(specifier);
    }
  };
  try {
    return await connectExtensionRemote(remoteName, entry, {
      ...(target.key === undefined ? {} : { key: target.key }),
      env: process.env,
      loadModule,
    });
  } catch (error) {
    failUsage(error instanceof Error ? error.message : String(error));
  }
}
