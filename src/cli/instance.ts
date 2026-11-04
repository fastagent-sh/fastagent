/**
 * Where a command's instance is (agent-artifact.md §4.1): the flags that place it, over the environment variables that
 * name the same inputs, settled once at the command's entry into absolute paths in this process's environment. A
 * `dev` worker inherits them, and every reader after (`resolveStateRoot`, `resolveWorkdir`, the instance configuration)
 * reads one answer.
 */
import { mkdirSync } from "node:fs";
import type { OpenServingOptions } from "../harnesses/pi-durable/serve.ts";
import {
  INSTANCE_CONFIG_ENV,
  INSTANCE_ROOT_ENV,
  INSTANCE_STATE_ENV,
  INSTANCE_WORKDIR_ENV,
  resolveOverridePath,
  resolveStateRoot,
  resolveWorkdir,
} from "../paths.ts";
import { failUsage } from "./fail.ts";
import type { FlagSpec } from "./kernel.ts";

/** The flags that place an instance, as the commander adapter hands them over. */
export interface InstanceFlags {
  root?: string;
  state?: string;
  workdir?: string;
  config?: string;
}

const INSTANCE_LOCATION: readonly (readonly [keyof InstanceFlags, string, string])[] = [
  ["root", "--root", INSTANCE_ROOT_ENV],
  ["state", "--state", INSTANCE_STATE_ENV],
  ["workdir", "--workdir", INSTANCE_WORKDIR_ENV],
  ["config", "--config", INSTANCE_CONFIG_ENV],
];

/** The flags of a command that opens, or reads the state of, an instance. */
export const INSTANCE_FLAGS: readonly FlagSpec[] = [
  {
    flags: "--root <dir>",
    description: `the instance root: its working directory, with its state in <dir>/.state (${INSTANCE_ROOT_ENV})`,
  },
  { flags: "--state <dir>", description: `the instance's state, apart from the root (${INSTANCE_STATE_ENV})` },
  {
    flags: "--workdir <dir>",
    description: `the agent's working directory, apart from the root (${INSTANCE_WORKDIR_ENV})`,
  },
];

/** `--config`: the instance configuration, a fastagent.json, for a command that opens the agent. */
export const CONFIG_FLAG: FlagSpec = {
  flags: "--config <file>",
  description: `the instance configuration, a fastagent.json (${INSTANCE_CONFIG_ENV}; dev reads the one at the project root)`,
};

export function instanceFlags(flags: Record<string, unknown>): InstanceFlags {
  const picked: InstanceFlags = {};
  for (const [key] of INSTANCE_LOCATION) {
    if (typeof flags[key] === "string") picked[key] = flags[key];
  }
  return picked;
}

function makeDirectory(path: string, source: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    failUsage(`${source} ${path} cannot be used as a directory: ${(error as Error).message}`);
  }
}

/**
 * Settle the instance's location: a flag beats its environment variable, a relative path is resolved against the
 * directory the command was started in (here, once), and the directories named are made. Refuses a flag with no path.
 */
export function enterInstanceLocation(flags: InstanceFlags = {}): void {
  for (const [key, flag, variable] of INSTANCE_LOCATION) {
    const given = flags[key];
    if (given !== undefined && given.trim() === "") failUsage(`${flag} needs a path`);
    const path = resolveOverridePath(given ?? process.env[variable]);
    if (path === undefined) continue;
    process.env[variable] = path;
    if (key === "root" || key === "workdir") makeDirectory(path, given === undefined ? variable : flag);
  }
}

/** Where `openServing` puts the instance of the agent in `agentDir`, as the flags and variables entered above say. */
export function instanceLocation(agentDir: string): Pick<OpenServingOptions, "projectDir" | "workdir" | "stateRoot"> {
  return { projectDir: agentDir, workdir: resolveWorkdir(agentDir), stateRoot: resolveStateRoot(agentDir) };
}
