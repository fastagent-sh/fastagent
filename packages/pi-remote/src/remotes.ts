/**
 * Local remote-agent configuration (`~/.config/fastagent/remotes.json`) and connection factory for HTTP and
 * Amazon Bedrock AgentCore deployments.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Agent, connectAgent } from "@fastagent-sh/client";

export interface HttpRemoteConfig {
  type: "http";
  url: string;
  apiKey?: string;
  sessionId?: string;
}

export interface AgentCoreRemoteConfig {
  type: "agentcore";
  runtimeArn: string;
  sessionId: string;
  qualifier?: string;
}

export type RemoteConfig = HttpRemoteConfig | AgentCoreRemoteConfig;

export interface RemotesFile {
  default?: string;
  remotes: Record<string, RemoteConfig>;
}

export interface LoadRemotesOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function defaultRemotesPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FASTAGENT_REMOTES_PATH?.trim();
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg || join(homedir(), ".config");
  return join(base, "fastagent", "remotes.json");
}

function expandEnvRef(value: string, field: string, env: NodeJS.ProcessEnv): string {
  if (!value.startsWith("$")) return value;
  const name = value.slice(1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return value;
  const resolved = env[name]?.trim();
  if (!resolved) {
    throw new Error(`Environment variable ${name} (referenced by ${field}) is not set`);
  }
  return resolved;
}

function parseRemoteEntry(name: string, raw: unknown): RemoteConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Remote "${name}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type ?? (typeof obj.runtimeArn === "string" ? "agentcore" : "http");

  if (type === "http") {
    if (typeof obj.url !== "string" || obj.url.trim() === "") {
      throw new Error(`Remote "${name}" requires a non-empty "url"`);
    }
    const trimmedUrl = obj.url.trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      throw new Error(`Remote "${name}" has invalid URL "${trimmedUrl}" (expected http:// or https://)`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`Remote "${name}" has invalid URL "${trimmedUrl}" (expected http:// or https://)`);
    }
    if (obj.apiKey !== undefined && typeof obj.apiKey !== "string") {
      throw new Error(`Remote "${name}" field "apiKey" must be a string`);
    }
    if (obj.sessionId !== undefined && typeof obj.sessionId !== "string") {
      throw new Error(`Remote "${name}" field "sessionId" must be a string`);
    }
    return {
      type: "http",
      url: trimmedUrl,
      ...(obj.apiKey !== undefined ? { apiKey: obj.apiKey } : {}),
      ...(obj.sessionId !== undefined ? { sessionId: obj.sessionId } : {}),
    };
  }

  if (type === "agentcore") {
    if (typeof obj.runtimeArn !== "string" || obj.runtimeArn.trim() === "") {
      throw new Error(`Remote "${name}" requires a non-empty "runtimeArn"`);
    }
    if (typeof obj.sessionId !== "string" || obj.sessionId.trim() === "") {
      throw new Error(`Remote "${name}" requires a non-empty "sessionId" for AgentCore`);
    }
    if (obj.qualifier !== undefined && typeof obj.qualifier !== "string") {
      throw new Error(`Remote "${name}" field "qualifier" must be a string`);
    }
    return {
      type: "agentcore",
      runtimeArn: obj.runtimeArn.trim(),
      sessionId: obj.sessionId.trim(),
      ...(obj.qualifier !== undefined ? { qualifier: obj.qualifier } : {}),
    };
  }

  throw new Error(`Remote "${name}" has unsupported type "${String(type)}" (expected "http" or "agentcore")`);
}

export function loadRemotes(options: LoadRemotesOptions = {}): { path: string; config: RemotesFile } {
  const env = options.env ?? process.env;
  const path = options.path ?? defaultRemotesPath(env);
  if (!existsSync(path)) {
    return { path, config: { remotes: {} } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse remotes config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Remotes config at ${path} must be a JSON object`);
  }
  const root = parsed as Record<string, unknown>;
  const rawRemotes = root.remotes;
  if (
    rawRemotes !== undefined &&
    (rawRemotes === null || typeof rawRemotes !== "object" || Array.isArray(rawRemotes))
  ) {
    throw new Error(`Remotes config at ${path}: "remotes" must be an object`);
  }
  const remotes: Record<string, RemoteConfig> = {};
  for (const [name, entry] of Object.entries((rawRemotes as Record<string, unknown> | undefined) ?? {})) {
    remotes[name] = parseRemoteEntry(name, entry);
  }
  const defaultName = typeof root.default === "string" && root.default.trim() !== "" ? root.default.trim() : undefined;
  return {
    path,
    config: {
      ...(defaultName !== undefined ? { default: defaultName } : {}),
      remotes,
    },
  };
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
  const isFirst = Object.keys(config.remotes).length === 0;
  const next: RemotesFile = {
    ...(options.setDefault || isFirst || !config.default ? { default: trimmed } : { default: config.default }),
    remotes: {
      ...config.remotes,
      [trimmed]: validated,
    },
  };
  writeRemotesFile(path, next);
  return { path, config: next };
}

export function removeRemote(
  name: string,
  options: LoadRemotesOptions = {},
): { path: string; config: RemotesFile; removed: boolean } {
  const { path, config } = loadRemotes(options);
  if (!(name in config.remotes)) {
    return { path, config, removed: false };
  }
  const rest = { ...config.remotes };
  delete rest[name];
  const remaining = Object.keys(rest);
  const nextDefault = config.default === name ? remaining[0] : config.default;
  const next: RemotesFile = {
    ...(nextDefault !== undefined ? { default: nextDefault } : {}),
    remotes: rest,
  };
  writeRemotesFile(path, next);
  return { path, config: next, removed: true };
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
    const apiKey = expandEnvRef(rawKey, `remotes.${name}.apiKey`, env);
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
  return {
    agent: agentcore.connectAgentCore({
      runtimeArn: remote.runtimeArn,
      sessionId: remote.sessionId,
      ...(remote.qualifier !== undefined ? { qualifier: remote.qualifier } : {}),
    }),
  };
}
