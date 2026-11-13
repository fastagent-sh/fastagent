/**
 * The environment of the processes an instance starts: the shell tool, stdio MCP servers and
 * skill scripts. Assembled from inputs, never the host process's whole `process.env`, so a stray variable of the host
 * (an API key, a cloud credential) cannot reach a command, and a declared one reaches every command.
 */
import { definedValues } from "./declared-secrets.ts";

const BASE_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);

/** The base environment `source` gives a process: the variables of the base list it holds, nothing else. */
export function baseEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(definedValues(source)).filter(([name]) => BASE_NAMES.has(name) || name.startsWith("LC_")),
  );
}

export interface ProcessEnvironmentInputs {
  /** The base environment (`baseEnv`). */
  base: Readonly<Record<string, string>>;
  /** The instance's secrets: only the declared names among them are passed on. */
  secrets: Readonly<Record<string, string | undefined>>;
  /** The names the definition declares (`needs()`). */
  declared: readonly string[];
  /** The agent's working directory. */
  workdir: string;
}

/** `GIT_CEILING_DIRECTORIES` at the workspace's parent, so git discovery stops at the workspace. */
const GIT_CEILING = "GIT_CEILING_DIRECTORIES";

/** What every process the agent starts gets, before an MCP server's own `env` is added for that server. */
export function processEnvironment(inputs: ProcessEnvironmentInputs, workspaceParent: string): Record<string, string> {
  const held = definedValues(inputs.secrets);
  const declared = Object.fromEntries(
    inputs.declared.flatMap((name) => (Object.hasOwn(held, name) ? [[name, held[name]]] : [])),
  );
  return { ...inputs.base, ...declared, [GIT_CEILING]: workspaceParent };
}
