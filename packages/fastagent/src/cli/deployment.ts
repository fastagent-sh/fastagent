/**
 * A served instance elsewhere, named either by `--url` or by `--remote <name>` from `~/.config/fastagent/remotes.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as Redacted from "effect/Redacted";
import type { AuthApi, RemoteAgent } from "@fastagent-sh/client/agent-api";
import { connectAgent } from "@fastagent-sh/client";
import { connectAuth } from "@fastagent-sh/client/auth";
import { applyEnvValues } from "../env.ts";
import { API_KEY_VARIABLE, apiKeysFrom } from "../http/server.ts";
import { readApiKeyEnv, readProcessEnv } from "../process-env.ts";
import { installProxyFetch } from "../proxy.ts";
import { loadEnvValues, valueFileOf } from "../value-file.ts";
import { failUsage } from "./fail.ts";
import { type InstanceFlags, enterEnvFile } from "./instance.ts";
import { expandRemoteEnvRef, parseRemotesJson, resolveRemotesPath } from "./remotes.ts";

export interface RemoteTargetFlags {
  url?: string;
  key?: string;
  remote?: string;
}

export function defaultRemotesPath(env: NodeJS.ProcessEnv = readProcessEnv()): string {
  return resolveRemotesPath(env, homedir());
}

function rejectPlacedInstance(instance: InstanceFlags | undefined, flagName: string): string | undefined {
  const { envFile, ...placed } = instance ?? {};
  for (const flag of Object.keys(placed)) {
    failUsage(`--${flag} places an instance this run opens, and ${flagName} opens none`);
  }
  return envFile;
}

function deploymentKey(where: string): Redacted.Redacted<string> {
  const [key] = apiKeysFrom(readApiKeyEnv());
  if (key === undefined) {
    failUsage(
      `no key to call ${where} with: pass --key, or set ${API_KEY_VARIABLE} in the environment of this command ` +
        "(or in the file --env-file names)",
    );
  }
  return key;
}

function enterRemoteEnvironment(dirArg: string): void {
  const file = valueFileOf(resolve(dirArg));
  if (file !== undefined) applyEnvValues(loadEnvValues(file));
  installProxyFetch();
}

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
    const apiKey = target.key ?? Redacted.value(deploymentKey(target.url));
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

  let apiKey: string;
  if (target.key !== undefined) {
    apiKey = target.key;
  } else if (entry.apiKey?.trim()) {
    try {
      apiKey = expandRemoteEnvRef(entry.apiKey.trim(), `remotes.${remoteName}.apiKey`, readProcessEnv());
    } catch (error) {
      failUsage(error instanceof Error ? error.message : String(error));
    }
  } else {
    apiKey = Redacted.value(deploymentKey(entry.url));
  }
  return {
    agent: connectAgent(entry.url, { apiKey }),
    auth: connectAuth(entry.url, { apiKey }),
    label: `${remoteName} (${entry.url})`,
    ...(entry.sessionId !== undefined ? { defaultSessionId: entry.sessionId } : {}),
  };
}
