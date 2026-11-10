/**
 * Where a command's instance is (agent-artifact.md §4.1): the flags that place it, over the environment variables that
 * name the same inputs, settled once at the command's entry into absolute paths in this process's environment. A
 * `dev` worker inherits them, and every reader after (`resolveStateRoot`, `resolveWorkdir`, the instance configuration)
 * reads one answer.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { baseEnv } from "../child-env.ts";
import { definedValues } from "../declared-secrets.ts";
import { enterAgentEnv } from "../env.ts";
import type { ContentInstance } from "../authoring.ts";
import { environmentConfig } from "../harnesses/pi-durable/environment-config.ts";
import type { OpenServingOptions } from "../harnesses/pi-durable/serve.ts";
import {
  INSTANCE_CONFIG_ENV,
  INSTANCE_ROOT_ENV,
  INSTANCE_STATE_ENV,
  INSTANCE_WORKDIR_ENV,
  isAgentcoreRuntime,
  isDeployedWorkspace,
  resolveOverridePath,
  resolveStateRoot,
  resolveWorkdir,
} from "../paths.ts";
import { INSTANCE_NAME_ENV, checkInstanceName, enteredInstanceName } from "../instance-name.ts";
import { type RunsAs, servedByDev } from "../serving-command.ts";
import { useValueFile } from "../value-file.ts";
import { failUsage } from "./fail.ts";
import type { FlagSpec } from "./kernel.ts";

/** The flags that place an instance, as the commander adapter hands them over. */
export interface InstanceFlags {
  name?: string;
  root?: string;
  state?: string;
  workdir?: string;
  config?: string;
  envFile?: string;
}

const INSTANCE_LOCATION: readonly (readonly [keyof InstanceFlags, string, string])[] = [
  ["root", "--root", INSTANCE_ROOT_ENV],
  ["state", "--state", INSTANCE_STATE_ENV],
  ["workdir", "--workdir", INSTANCE_WORKDIR_ENV],
  ["config", "--config", INSTANCE_CONFIG_ENV],
];

const NAME_FLAG: FlagSpec = {
  flags: "--name <name>",
  description: `the instance's name, one path segment (${INSTANCE_NAME_ENV}; default: the program's name)`,
};
const ROOT_FLAG: FlagSpec = {
  flags: "--root <dir>",
  description: `the instance root: its working directory, with its state in <dir>/.state (${INSTANCE_ROOT_ENV})`,
};
const STATE_FLAG: FlagSpec = {
  flags: "--state <dir>",
  description: `the instance's state, apart from the root (${INSTANCE_STATE_ENV})`,
};
const WORKDIR_FLAG: FlagSpec = {
  flags: "--workdir <dir>",
  description: `the agent's working directory, apart from the root (${INSTANCE_WORKDIR_ENV})`,
};

/** The flags of a command that opens, or reads the state of, an instance. */
export const INSTANCE_FLAGS: readonly FlagSpec[] = [NAME_FLAG, ROOT_FLAG, STATE_FLAG, WORKDIR_FLAG];

/** The flags of a command that reads or edits what an instance works on: where it keeps its clones, and its file. */
export const CONTENT_FLAGS: readonly FlagSpec[] = [
  ROOT_FLAG,
  WORKDIR_FLAG,
  {
    flags: "--config <file>",
    description: `the instance configuration to read and edit, a fastagent.json (${INSTANCE_CONFIG_ENV}; default: the project's)`,
  },
];

/** `--config`: the instance configuration, a fastagent.json, for a command that opens the agent. */
export const CONFIG_FLAG: FlagSpec = {
  flags: "--config <file>",
  description: `the instance configuration, a fastagent.json (${INSTANCE_CONFIG_ENV}; dev reads the one at the project root)`,
};

export function instanceFlags(flags: Record<string, unknown>): InstanceFlags {
  const picked: InstanceFlags = {};
  for (const key of [...INSTANCE_LOCATION.map(([name]) => name), "name" as const, "envFile" as const]) {
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

/** `--env-file`: the file the agent's values are read from, for a command that opens the agent or reads them. */
export const ENV_FILE_FLAG: FlagSpec = {
  flags: "--env-file <file>",
  description: "the file the agent's secrets are read from, over the default (.secrets/.env); it must exist",
};

/**
 * `--env-file`, settled before the agent's values are entered: absolute, and a file that exists. Without the flag the
 * command's default file is used again, whatever an earlier command in this process chose.
 */
export function enterEnvFile(given: string | undefined): void {
  if (given === undefined) {
    useValueFile(undefined);
    return;
  }
  if (given.trim() === "") failUsage("--env-file needs a path");
  const path = resolveOverridePath(given) as string;
  if (!existsSync(path) || !statSync(path).isFile()) failUsage(`--env-file ${path} is not a file`);
  useValueFile(path);
}

/**
 * Enter the agent's directory as a command runs it: the value file, whose values become this process's environment
 * and so the instance's secrets, then where the instance is.
 */
export function enterInstance(agentDir: string, flags: InstanceFlags = {}): void {
  enterEnvFile(flags.envFile);
  enterAgentEnv(agentDir);
  enterInstanceLocation(flags);
}

/** Where a content command reads and edits an agent's content, as its flags and variables say. */
export function contentInstanceOf(agentDir: string, flags: InstanceFlags = {}): ContentInstance {
  enterInstanceLocation(flags);
  const config = process.env[INSTANCE_CONFIG_ENV];
  return { workdir: resolveWorkdir(agentDir), ...(config === undefined ? {} : { config }) };
}

/**
 * Settle the instance's location: a flag beats its environment variable, a relative path is resolved against the
 * directory the command was started in (here, once), and the directories named are made. Refuses a flag with no path.
 */
function enterInstanceLocation(flags: InstanceFlags = {}): void {
  for (const [key, flag, variable] of INSTANCE_LOCATION) {
    const given = flags[key];
    if (given !== undefined && given.trim() === "") failUsage(`${flag} needs a path`);
    const path = resolveOverridePath(given ?? process.env[variable]);
    if (path === undefined) continue;
    process.env[variable] = path;
    if (key === "root" || key === "workdir") makeDirectory(path, given === undefined ? variable : flag);
  }
  const name = flags.name ?? enteredInstanceName();
  if (name === undefined) return;
  try {
    checkInstanceName(name);
  } catch (error) {
    failUsage(`${flags.name === undefined ? INSTANCE_NAME_ENV : "--name"}: ${(error as Error).message}`);
  }
  process.env[INSTANCE_NAME_ENV] = name;
}

/** Who runs this process's instance, as its own variables say: the one place the CLI reads them for an open. */
export function runsAsIn(env: NodeJS.ProcessEnv): RunsAs {
  return { dev: servedByDev(env), deployed: isDeployedWorkspace(env), agentcore: isAgentcoreRuntime(env) };
}

/**
 * What `openServing` is given for the agent in `agentDir`, as the flags and variables entered above say: where the
 * instance is, and its secrets, which for a command are its environment once the value file is entered.
 */
export function instanceInputs(
  agentDir: string,
): Pick<
  OpenServingOptions,
  "projectDir" | "workdir" | "stateRoot" | "secrets" | "env" | "ownEnv" | "runsAs" | "name" | "overrides"
> {
  const workdir = resolveWorkdir(agentDir);
  // A default one is the project's own `.fastagent/<environment>/`, which nothing has made yet.
  makeDirectory(workdir, "the working directory");
  return {
    projectDir: agentDir,
    ...(enteredInstanceName() === undefined ? {} : { name: enteredInstanceName() as string }),
    workdir,
    stateRoot: resolveStateRoot(agentDir),
    secrets: definedValues(process.env),
    env: baseEnv(process.env),
    ownEnv: process.env,
    runsAs: runsAsIn(process.env),
    overrides: environmentConfig(process.env),
  };
}
