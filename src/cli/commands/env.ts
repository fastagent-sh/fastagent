/**
 * `fastagent env add|remove|list|install|exec`: the agent's environment, declared under `environment` in context.json
 * and installed by the agent's own mise (docs/design/agent-service.md §4), in the agent directory, the current one.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadEnvironment, readContextFile } from "../../content/file.ts";
import { aptAdvice, missingAptPackages } from "../../environment/apt.ts";
import {
  type DeclaredEnvironment,
  declareEnvironment,
  declaredVariables,
  parsePackageArgument,
  runtimeAdvice,
} from "../../environment/declare.ts";
import { checkPackages, ensureMise, enterEnvironment, installPackages, miseBinary } from "../../environment/mise.ts";
import { writeEnvironment } from "../../authoring.ts";
import { log } from "../../log.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";
import { dotEnvPath, enterAgentEnv } from "../../env.ts";
import { missingSecrets } from "../../declared-secrets.ts";

const NONE: DeclaredEnvironment = { packages: {}, aptPackages: [], variables: {} };

/**
 * The agent directory, the current one, entered as every command that runs in it is: its `.env` in `process.env`, and
 * the proxy that `.env` may declare. mise's downloads go through that proxy, and `env exec` runs its command with the
 * same values the agent's own commands get.
 */
function enterAgentHere(): string {
  const agentDir = agentDirOrExit(resolve("."));
  enterAgentEnv(agentDir);
  return agentDir;
}

export async function runEnvAdd(args: string[]): Promise<void> {
  const agentDir = enterAgentHere();
  const parsed = args.map(parsePackageArgument);
  const apt = parsed.flatMap((one) => ("apt" in one ? [one.apt] : []));
  await edit(agentDir, (current) => {
    const packages = { ...current.packages };
    const aptPackages = [...current.aptPackages];
    for (const one of parsed) {
      if ("apt" in one) {
        if (!aptPackages.includes(one.apt)) aptPackages.push(one.apt);
      } else {
        packages[one.name] = one.version;
      }
    }
    return { ...current, packages, aptPackages };
  }).catch(failStartup);
  const missing = missingAptPackages(apt);
  if (missing && missing.length > 0) log.warn(`[fastagent] ${aptAdvice(missing)}`);
}

export async function runEnvRemove(args: string[]): Promise<void> {
  const agentDir = enterAgentHere();
  await edit(agentDir, (current) => {
    const packages = { ...current.packages };
    let aptPackages = [...current.aptPackages];
    for (const arg of args) {
      const apt = arg.startsWith("apt:") ? arg.slice("apt:".length) : undefined;
      const declared = apt !== undefined ? aptPackages.includes(apt) : Object.hasOwn(packages, arg);
      if (!declared) throw noPackage(current, arg);
      if (apt !== undefined) aptPackages = aptPackages.filter((name) => name !== apt);
      else delete packages[arg];
    }
    return { ...current, packages, aptPackages };
  }).catch(failStartup);
}

export async function runEnvList(opts: { json?: boolean } = {}): Promise<void> {
  const agentDir = enterAgentHere();
  const declared = await Promise.resolve()
    .then(() => loadEnvironment(agentDir) ?? NONE)
    .catch(failStartup);
  const variables = declaredVariables(declared);
  if (opts.json) {
    // Whether each variable has a value here, never the value.
    const listed = {
      packages: Object.entries(declared.packages).map(([name, version]) => ({ name, version })),
      apt: declared.aptPackages,
      variables: variables.map(({ name, description }) => ({ name, description, set: Boolean(process.env[name]) })),
    };
    console.log(JSON.stringify(listed, null, 2));
  } else {
    printEnvironment(declared, variables);
  }
  if (Object.keys(declared.packages).length > 0) {
    const bin = miseBinary(agentDir);
    if (!bin) {
      log.warn(
        `[fastagent] the packages are not checked: the agent's mise is not installed here — run ` +
          `\`fastagent env install\``,
      );
    } else {
      const { refusals, runtime } = await checkPackages(agentDir, bin, declared.packages).catch(failStartup);
      for (const refusal of refusals) log.warn(`[fastagent] ${refusal}`);
      if (runtime) log.warn(`[fastagent] ${runtimeAdvice(runtime)}`);
    }
  }
  const missing = missingAptPackages(declared.aptPackages);
  if (missing && missing.length > 0) log.warn(`[fastagent] ${aptAdvice(missing)}`);
  const unset = missingSecrets(variables).map(({ name }) => name);
  if (unset.length > 0) {
    log.warn(
      `[fastagent] no value here for ${unset.join(", ")}: dev and start refuse to run until they have one — set ` +
        `them in ${dotEnvPath(agentDir)}`,
    );
  }
}

function printEnvironment(declared: DeclaredEnvironment, variables: ReturnType<typeof declaredVariables>): void {
  const names = [
    ...Object.keys(declared.packages),
    ...declared.aptPackages.map((name) => `apt:${name}`),
    ...variables.map(({ name }) => name),
  ];
  if (names.length === 0) console.log("(none: the agent runs this machine's commands)");
  const width = Math.max(0, ...names.map((name) => name.length));
  for (const [name, version] of Object.entries(declared.packages)) {
    console.log(`${name.padEnd(width)}  ${version}`);
  }
  for (const name of declared.aptPackages) console.log(`${`apt:${name}`.padEnd(width)}  (installed by the image)`);
  // Whether each has a value here, never the value.
  for (const { name, description } of variables) {
    console.log(`${name.padEnd(width)}  ${(process.env[name] ? "set" : "not set").padEnd(8)}  ${description}`);
  }
}

/**
 * Install what context.json declares here, mise first when the agent has none (into its package.json): every package at
 * the newest release its version allows, a newer one where one is out. Apt packages are the image's: one missing here
 * is said, with how.
 */
export async function runEnvInstall(): Promise<void> {
  const agentDir = enterAgentHere();
  await Promise.resolve()
    .then(async () => {
      const declared = loadEnvironment(agentDir) ?? NONE;
      if (Object.keys(declared.packages).length > 0) {
        await installPackages(agentDir, await checkedMise(agentDir, declared.packages), declared.packages, "all");
        // Nothing in the agent directory changes, so `dev` does not restart: its PATH names the releases it started on.
        log.info("[fastagent] a running `fastagent dev` keeps the releases it started with until it restarts");
      }
      const missing = missingAptPackages(declared.aptPackages);
      if (missing && missing.length > 0) log.warn(`[fastagent] ${aptAdvice(missing)}`);
    })
    .catch(failStartup);
}

export async function runEnvExec(command: string[]): Promise<void> {
  const agentDir = enterAgentHere();
  await enterEnvironment(agentDir).catch(failStartup);
  const [program, ...args] = command as [string, ...string[]];
  const code = await new Promise<number>((done, fail) => {
    const child = spawn(program, args, { stdio: "inherit" });
    child.on("error", fail);
    child.on("close", (exit, signal) => done(exit ?? (signal ? 1 : 0)));
  }).catch((error: NodeJS.ErrnoException) =>
    failStartup(error.code === "ENOENT" ? new Error(`${program}: command not found in the environment`) : error),
  );
  process.exit(code);
}

/**
 * Change the declaration with `change`, checked as a whole. A package it adds or declares at another version is checked
 * and installed first at the newest release its version allows, whatever older one this machine has, so a declared
 * package is one that installs; what else it declares is installed when nothing here matches it. The declaration is
 * then written under context.json's lock, `change` applied to it as it is by then, so two edits at once keep both.
 * `change` is therefore called twice, and computes alone.
 */
async function edit(
  agentDir: string,
  change: (current: DeclaredEnvironment) => DeclaredEnvironment,
): Promise<DeclaredEnvironment> {
  // Read whole, as the write that follows is: a refused content entry stops the edit before anything is installed.
  const current = readContextFile(agentDir).environment ?? NONE;
  const next = declareEnvironment(change(current)) ?? NONE;
  const added = Object.keys(next.packages).filter((name) => current.packages[name] !== next.packages[name]);
  if (added.length > 0) {
    await installPackages(agentDir, await checkedMise(agentDir, next.packages), next.packages, added);
  }
  return writeEnvironment(agentDir, (now) => declareEnvironment(change(now ?? NONE)) ?? NONE);
}

/** The refusal for a package `environment` does not declare, with what it does. */
function noPackage(environment: DeclaredEnvironment, name: string): Error {
  const has = [...Object.keys(environment.packages), ...environment.aptPackages.map((apt) => `apt:${apt}`)];
  return new Error(`the environment has no package "${name}" (it has: ${has.join(", ") || "none"})`);
}

/** The agent's mise (added when it has none), once `packages` pass: a refused one stops the command. */
async function checkedMise(agentDir: string, packages: Record<string, string>): Promise<string> {
  const bin = await ensureMise(agentDir);
  const { refusals, runtime } = await checkPackages(agentDir, bin, packages);
  if (refusals.length > 0) throw new Error(refusals.join("\n"));
  if (runtime) log.warn(`[fastagent] ${runtimeAdvice(runtime)}`);
  return bin;
}
