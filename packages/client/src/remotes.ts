/**
 * Pure schema and resolution helpers for the shared `remotes.json` configuration used by FastAgent CLI
 * (`--remote`) and remote clients (`@fastagent-sh/pi-remote`). Imports no Node APIs so `@fastagent-sh/client`
 * remains runtime-neutral.
 */

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

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function expandRemoteEnvRef(
  value: string,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (!value.startsWith("$")) return value;
  const name = value.slice(1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return value;
  const resolved = env[name]?.trim();
  if (!resolved) {
    throw new Error(`Environment variable ${name} (referenced by ${field}) is not set`);
  }
  return resolved;
}

export function parseRemoteEntry(name: string, raw: unknown): RemoteConfig {
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

export function parseRemotesJson(raw: string, sourceLabel: string): RemotesFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse remotes config at ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Remotes config at ${sourceLabel} must be a JSON object`);
  }
  const root = parsed as Record<string, unknown>;
  const rawRemotes = root.remotes;
  if (
    rawRemotes !== undefined &&
    (rawRemotes === null || typeof rawRemotes !== "object" || Array.isArray(rawRemotes))
  ) {
    throw new Error(`Remotes config at ${sourceLabel}: "remotes" must be an object`);
  }
  const remotes: Record<string, RemoteConfig> = {};
  for (const [name, entry] of Object.entries((rawRemotes as Record<string, unknown> | undefined) ?? {})) {
    remotes[name] = parseRemoteEntry(name, entry);
  }
  const defaultName = typeof root.default === "string" && root.default.trim() !== "" ? root.default.trim() : undefined;
  return {
    ...(defaultName !== undefined ? { default: defaultName } : {}),
    remotes,
  };
}

export function upsertRemoteConfig(
  config: RemotesFile,
  name: string,
  remote: RemoteConfig,
  options: { setDefault?: boolean } = {},
): RemotesFile {
  const trimmed = name.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new Error(`Invalid remote name "${name}": must be non-empty without whitespace`);
  }
  const validated = parseRemoteEntry(trimmed, remote);
  const isFirst = Object.keys(config.remotes).length === 0;
  return {
    ...(options.setDefault || isFirst || !config.default ? { default: trimmed } : { default: config.default }),
    remotes: {
      ...config.remotes,
      [trimmed]: validated,
    },
  };
}

export function removeRemoteConfig(config: RemotesFile, name: string): { config: RemotesFile; removed: boolean } {
  if (!(name in config.remotes)) {
    return { config, removed: false };
  }
  const rest = { ...config.remotes };
  delete rest[name];
  const remaining = Object.keys(rest);
  const nextDefault = config.default === name ? remaining[0] : config.default;
  return {
    config: {
      ...(nextDefault !== undefined ? { default: nextDefault } : {}),
      remotes: rest,
    },
    removed: true,
  };
}
