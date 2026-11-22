/**
 * Where a command's instance is: the flags that place it, over the environment variables that
 * name the same inputs, settled once at the command's entry into absolute paths in this process's environment. A
 * `dev` worker inherits them, and every reader after (`resolveStateRoot`, `resolveWorkdir`) reads one answer.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { baseEnv } from "../child-env.ts";
import { definedValues } from "../declared-secrets.ts";
import { enterAgentEnv } from "../env.ts";
import type { OpenServingOptions } from "../harnesses/serving.ts";
import {
  DATABASE_URL_ENV,
  INSTANCE_ROOT_ENV,
  type InstanceMode,
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
  envFile?: string;
}

const NAME_FLAG: FlagSpec = {
  flags: "--name <name>",
  description: `the instance's name, one path segment (${INSTANCE_NAME_ENV}; default: the program's name)`,
};
const ROOT_FLAG: FlagSpec = {
  flags: "--root <dir>",
  description: `the instance root: its working directory, with its state in <dir>/.state (${INSTANCE_ROOT_ENV})`,
};

/** The flags of a command that opens, or reads the state of, an instance. */
export const INSTANCE_FLAGS: readonly FlagSpec[] = [NAME_FLAG, ROOT_FLAG];

export function instanceFlags(flags: Record<string, unknown>): InstanceFlags {
  const picked: InstanceFlags = {};
  for (const key of ["root", "name", "envFile"] as const) {
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
export function enterEnvFile(
  given: string | undefined,
  /** `mayCreate`: the file is one this command writes, so a missing one is made by its first value. */
  options: { defaultFile?: boolean; mayCreate?: boolean } = {},
): void {
  const { mayCreate = false, ...choice } = options;
  if (given === undefined) {
    useValueFile(undefined, choice);
    return;
  }
  if (given.trim() === "") failUsage("--env-file needs a path");
  const path = resolveOverridePath(given) as string;
  if (existsSync(path) ? !statSync(path).isFile() : !mayCreate) failUsage(`--env-file ${path} is not a file`);
  useValueFile(path, choice);
}

/**
 * Enter the agent's directory as a command runs it: the value file, whose values become this process's environment
 * and so the instance's secrets, then where the instance is.
 */
export function enterInstance(agentDir: string, flags: InstanceFlags = {}): void {
  enterEnvFile(flags.envFile, { defaultFile: true });
  enterAgentEnv(agentDir);
  enterInstanceLocation(flags);
}

/**
 * Settle the instance's location: a flag beats its environment variable, a relative path is resolved against the
 * directory the command was started in (here, once), and the directories named are made. Refuses a flag with no path.
 */
function enterInstanceLocation(flags: InstanceFlags = {}): void {
  if (flags.root !== undefined && flags.root.trim() === "") failUsage("--root needs a path");
  const root = resolveOverridePath(flags.root ?? process.env[INSTANCE_ROOT_ENV]);
  if (root !== undefined) {
    process.env[INSTANCE_ROOT_ENV] = root;
    makeDirectory(root, flags.root === undefined ? INSTANCE_ROOT_ENV : "--root");
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
function runsAsIn(env: NodeJS.ProcessEnv): RunsAs {
  return {
    dev: servedByDev(env),
    deployed: isDeployedWorkspace(env),
  };
}

/** An instance in a database is opened by the name it is given: a command that opens one without a name exits 2. */
function refuseUnnamedDatabaseInstance(): void {
  if (process.env[DATABASE_URL_ENV] && enteredInstanceName() === undefined) {
    failUsage(
      `${DATABASE_URL_ENV} keeps the sessions in a database that instances share by name: ` +
        `name this one with --name <name> or ${INSTANCE_NAME_ENV}`,
    );
  }
}

/**
 * What `openServing` is given for the agent in `agentDir`, as the flags and variables entered above say: where the
 * instance is, and its secrets, which for a command are its environment once the value file is entered.
 */
export function instanceInputs(
  agentDir: string,
  options: { mode?: InstanceMode } = {},
): Pick<OpenServingOptions, "projectDir" | "workdir" | "stateRoot" | "secrets" | "env" | "ownEnv" | "runsAs" | "name"> {
  refuseUnnamedDatabaseInstance();
  const mode = options.mode ?? "dev";
  const workdir = resolveWorkdir(agentDir, process.env, mode);
  // A default one is the project's own `.fastagent/<mode>/`, which nothing has made yet.
  makeDirectory(workdir, "the working directory");
  return {
    projectDir: agentDir,
    ...(enteredInstanceName() === undefined ? {} : { name: enteredInstanceName() as string }),
    workdir,
    stateRoot: resolveStateRoot(agentDir, process.env, mode),
    secrets: definedValues(process.env),
    env: baseEnv(process.env),
    ownEnv: process.env,
    runsAs: runsAsIn(process.env),
  };
}
