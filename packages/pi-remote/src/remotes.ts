/**
 * Local file persistence and connection factory for `~/.config/fastagent/remotes.json`, sharing schema parsing and
 * env expansion with FastAgent CLI via `@fastagent-sh/client/remotes`.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Agent, connectAgent } from "@fastagent-sh/client";
import {
  type AgentCoreRemoteConfig,
  type HttpRemoteConfig,
  type RemoteConfig,
  type RemotesFile,
  expandRemoteEnvRef,
  isHttpUrl,
  parseRemoteEntry,
  parseRemotesJson,
  removeRemoteConfig,
  upsertRemoteConfig,
} from "@fastagent-sh/client/remotes";

export type { AgentCoreRemoteConfig, HttpRemoteConfig, RemoteConfig, RemotesFile };
export { isHttpUrl };

export interface LoadRemotesOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export function defaultRemotesPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FASTAGENT_REMOTES_PATH?.trim();
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg || join(homedir(), ".config");
  return join(base, "fastagent", "remotes.json");
}

export function loadRemotes(options: LoadRemotesOptions = {}): { path: string; config: RemotesFile } {
  const env = options.env ?? process.env;
  const path = options.path ?? defaultRemotesPath(env);
  if (!existsSync(path)) {
    return { path, config: { remotes: {} } };
  }
  return { path, config: parseRemotesJson(readFileSync(path, "utf8"), path) };
}

function writeRemotesFile(path: string, config: RemotesFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function saveRemote(
  name: string,
  remote: RemoteConfig,
  options: LoadRemotesOptions & { setDefault?: boolean } = {},
): { path: string; config: RemotesFile } {
  const trimmed = name.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new Error(`Invalid remote name "${name}": must be non-empty without whitespace`);
  }
  const validated = parseRemoteEntry(trimmed, remote);
  const { path, config } = loadRemotes(options);
  const next = upsertRemoteConfig(config, trimmed, validated, options);
  writeRemotesFile(path, next);
  return { path, config: next };
}

export function removeRemote(
  name: string,
  options: LoadRemotesOptions = {},
): { path: string; config: RemotesFile; removed: boolean } {
  const { path, config } = loadRemotes(options);
  const { config: next, removed } = removeRemoteConfig(config, name);
  if (removed) writeRemotesFile(path, next);
  return { path, config: next, removed };
}

export async function connectRemote(
  name: string,
  remote: RemoteConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ agent: Agent; defaultSessionId?: string }> {
  if (remote.type === "http") {
    const rawKey = remote.apiKey?.trim() || env.FASTAGENT_API_KEY?.split(",")[0]?.trim();
    if (!rawKey) {
      throw new Error(`Remote "${name}" has no apiKey configured and FASTAGENT_API_KEY is not set`);
    }
    const apiKey = expandRemoteEnvRef(rawKey, `remotes.${name}.apiKey`, env);
    return {
      agent: connectAgent(remote.url, { apiKey }),
      ...(remote.sessionId !== undefined ? { defaultSessionId: remote.sessionId } : {}),
    };
  }

  let agentcore: typeof import("@fastagent-sh/client/agentcore");
  try {
    agentcore = await import("@fastagent-sh/client/agentcore");
  } catch (error) {
    throw new Error(
      `Remote "${name}" uses AgentCore; install @aws-sdk/client-bedrock-agentcore to connect (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const connection = {
    runtimeArn: remote.runtimeArn,
    sessionId: remote.sessionId,
    ...(remote.qualifier !== undefined ? { qualifier: remote.qualifier } : {}),
  };
  return {
    agent: agentcore.connectAgentCore(connection),
  };
}
