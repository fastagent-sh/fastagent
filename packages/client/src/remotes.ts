/**
 * Pure schema, resolution, and transport-plugin contract for the shared `remotes.json` configuration used by
 * FastAgent CLI (`--remote`) and remote clients (`@fastagent-sh/pi-remote`). Imports no Node APIs and no
 * cloud-vendor packages so `@fastagent-sh/client` stays completely runtime- and cloud-neutral.
 */
import type { AuthApi, RemoteAgent } from "./agent-api.ts";

export interface HttpRemoteConfig {
  type: "http";
  url: string;
  apiKey?: string;
  sessionId?: string;
}

/** A remote backed by a cloud transport extension package (`@fastagent-sh/<type>/client`). */
export interface ExtensionRemoteConfig {
  type: string;
  [field: string]: unknown;
}

export type RemoteConfig = HttpRemoteConfig | ExtensionRemoteConfig;

export interface RemotesFile {
  default?: string;
  remotes: Record<string, RemoteConfig>;
}

/** What a resolved remote transport returns to CLI or UI clients. */
export interface RemoteConnection {
  readonly agent: RemoteAgent;
  readonly auth: AuthApi;
  readonly label: string;
  readonly defaultSessionId?: string;
}

export interface RemoteConnectOptions {
  readonly key?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Entry contract exported by `@fastagent-sh/<type>/client` for non-HTTP remotes in `remotes.json`. */
interface RemoteTransportModule {
  connectRemote(
    name: string,
    config: ExtensionRemoteConfig,
    options?: RemoteConnectOptions,
  ): RemoteConnection | Promise<RemoteConnection>;
}

const EXTENSION_TYPE = /^[a-z][a-z0-9-]*$/;

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function isHttpRemote(remote: RemoteConfig): remote is HttpRemoteConfig {
  return remote.type === "http";
}

/** The package specifier that provides the transport for non-HTTP remote `type`. */
function remoteTransportSpecifier(type: string): string {
  return `@fastagent-sh/${type}/client`;
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
  const type = obj.type ?? "http";
  if (typeof type !== "string" || !EXTENSION_TYPE.test(type)) {
    throw new Error(
      `Remote "${name}" has invalid type "${String(type)}" (expected "http" or a lowercase extension name)`,
    );
  }

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

  return { ...obj, type };
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

/**
 * Load and invoke a cloud transport plugin (`@fastagent-sh/<type>/client`) for a non-HTTP remote entry.
 * Callers may supply a custom `loadModule` resolver (e.g. resolving from an agent directory's `node_modules`).
 */
export async function connectExtensionRemote(
  name: string,
  remote: ExtensionRemoteConfig,
  options: RemoteConnectOptions & { readonly loadModule?: (specifier: string) => Promise<unknown> } = {},
): Promise<RemoteConnection> {
  if (!EXTENSION_TYPE.test(remote.type) || remote.type === "http") {
    throw new Error(`Remote "${name}" has unsupported transport type "${remote.type}"`);
  }
  const pkg = `@fastagent-sh/${remote.type}`;
  const specifier = remoteTransportSpecifier(remote.type);
  const load = options.loadModule ?? ((spec: string) => import(spec));
  let mod: Partial<RemoteTransportModule>;
  try {
    mod = (await load(specifier)) as Partial<RemoteTransportModule>;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Remote "${name}" uses transport "${remote.type}"; install ${pkg} to connect (${msg})`, {
      cause: error,
    });
  }
  if (typeof mod.connectRemote !== "function") {
    throw new Error(`Transport package ${specifier} does not export connectRemote()`);
  }
  return mod.connectRemote(name, remote, {
    ...(options.key === undefined ? {} : { key: options.key }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}
