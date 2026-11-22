/**
 * `fastagent remote <list|add|remove|default>`: manage named remote FastAgent instances in
 * `~/.config/fastagent/remotes.json` (overridable via `FASTAGENT_REMOTES_PATH`), shared with `--remote`
 * and `@fastagent-sh/pi-remote`.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  type RemoteConfig,
  type RemotesFile,
  isHttpRemote,
  parseRemotesJson,
  removeRemoteConfig,
  setDefaultRemoteConfig,
  upsertRemoteConfig,
} from "@fastagent-sh/client/remotes";
import { writeFileAtomic } from "../../atomic-write.ts";
import { defaultRemotesPath } from "../deployment.ts";
import { failUsage } from "../fail.ts";

function loadRemotesFile(): { path: string; config: RemotesFile } {
  const path = defaultRemotesPath();
  if (!existsSync(path)) return { path, config: { remotes: {} } };
  try {
    return { path, config: parseRemotesJson(readFileSync(path, "utf8"), path) };
  } catch (error) {
    failUsage(error instanceof Error ? error.message : String(error));
  }
}

function saveRemotesFile(path: string, config: RemotesFile): void {
  writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

/** Never print raw API keys to stdout: preserve `$ENV_VAR` references, redact literal secrets. */
function redactRemote(remote: RemoteConfig): Record<string, unknown> {
  if (!isHttpRemote(remote)) return { ...remote };
  const apiKey = remote.apiKey === undefined ? undefined : remote.apiKey.startsWith("$") ? remote.apiKey : "***";
  return {
    type: "http",
    url: remote.url,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(remote.sessionId === undefined ? {} : { sessionId: remote.sessionId }),
  };
}

export function runRemoteList(opts: { json?: boolean } = {}): void {
  const { path, config } = loadRemotesFile();
  const names = Object.keys(config.remotes);
  if (opts.json) {
    const remotes = Object.fromEntries(names.map((name) => [name, redactRemote(config.remotes[name] as RemoteConfig)]));
    console.log(
      JSON.stringify(
        {
          path,
          ...(config.default === undefined ? {} : { default: config.default }),
          remotes,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (names.length === 0) {
    console.log(`remotes: (none in ${path})`);
    return;
  }
  console.log(`remotes (${path}):`);
  for (const name of names) {
    const entry = config.remotes[name] as RemoteConfig;
    const star = config.default === name ? "*" : " ";
    if (isHttpRemote(entry)) {
      const keyLabel =
        entry.apiKey === undefined
          ? "env FASTAGENT_API_KEY"
          : entry.apiKey.startsWith("$")
            ? entry.apiKey
            : "saved key";
      console.log(` ${star} ${name}  ${entry.url}  (${keyLabel})`);
    } else {
      console.log(` ${star} ${name}  [${entry.type}]`);
    }
  }
}

export function runRemoteAdd(
  name: string,
  url: string,
  opts: { key?: string; session?: string; default?: boolean } = {},
): void {
  const { path, config } = loadRemotesFile();
  const entry: RemoteConfig = {
    type: "http",
    url,
    ...(opts.key !== undefined ? { apiKey: opts.key } : {}),
    ...(opts.session !== undefined ? { sessionId: opts.session } : {}),
  };
  let next: RemotesFile;
  try {
    next = upsertRemoteConfig(config, name, entry, { setDefault: opts.default === true });
  } catch (error) {
    failUsage(error instanceof Error ? error.message : String(error));
  }
  saveRemotesFile(path, next);
  const trimmed = name.trim();
  const isDefault = next.default === trimmed ? " (default)" : "";
  console.log(`saved remote "${trimmed}"${isDefault} -> ${url} (${path})`);
}

export function runRemoteRemove(name: string): void {
  const { path, config } = loadRemotesFile();
  const { config: next, removed } = removeRemoteConfig(config, name);
  if (!removed) failUsage(`unknown remote "${name}" in ${path}`);
  saveRemotesFile(path, next);
  console.log(`removed remote "${name}" (${path})`);
}

export function runRemoteDefault(name: string): void {
  const { path, config } = loadRemotesFile();
  let next: RemotesFile;
  try {
    next = setDefaultRemoteConfig(config, name);
  } catch (error) {
    failUsage(error instanceof Error ? error.message : String(error));
  }
  saveRemotesFile(path, next);
  console.log(`default remote set to "${next.default}" (${path})`);
}
