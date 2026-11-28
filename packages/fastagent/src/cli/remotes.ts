/**
 * Pure schema and CRUD operations for `~/.config/fastagent/remotes.json` (used by `fastagent remote` and `--remote`).
 */
export interface RemoteConfig {
  type: "http";
  url: string;
  apiKey?: string;
  sessionId?: string;
}

export interface RemotesFile {
  default?: string;
  remotes: Record<string, RemoteConfig>;
}

const ENV_REF = /^\$[A-Za-z_][A-Za-z0-9_]*$/;

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && (value.charCodeAt(end - 1) === 47 || value.charCodeAt(end - 1) === 92)) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Resolve the path to `remotes.json` from `FASTAGENT_REMOTES_PATH`, `XDG_CONFIG_HOME`, or `homeDir`. */
export function resolveRemotesPath(env: Readonly<Record<string, string | undefined>>, homeDir: string): string {
  const override = env.FASTAGENT_REMOTES_PATH?.trim();
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = stripTrailingSlashes(xdg || `${stripTrailingSlashes(homeDir)}/.config`);
  return `${base}/fastagent/remotes.json`;
}

export function isRemoteEnvRef(value: string): boolean {
  return ENV_REF.test(value);
}

export function redactRemoteConfig(remote: RemoteConfig): Record<string, unknown> {
  const apiKey = remote.apiKey === undefined ? undefined : isRemoteEnvRef(remote.apiKey) ? remote.apiKey : "***";
  return {
    type: "http",
    url: remote.url,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(remote.sessionId === undefined ? {} : { sessionId: remote.sessionId }),
  };
}

export function expandRemoteEnvRef(
  value: string,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (!isRemoteEnvRef(value)) return value;
  const name = value.slice(1);
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
  const type = obj.type ?? "http";
  if (type !== "http") {
    throw new Error(`Remote "${name}" has unsupported type "${String(type)}" (expected "http")`);
  }
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

export function setDefaultRemoteConfig(config: RemotesFile, name: string): RemotesFile {
  const trimmed = name.trim();
  if (!(trimmed in config.remotes)) {
    const names = Object.keys(config.remotes);
    const available = names.length > 0 ? ` (configured: ${names.join(", ")})` : " (no remotes configured)";
    throw new Error(`Unknown remote "${trimmed}"${available}`);
  }
  return { ...config, default: trimmed };
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
