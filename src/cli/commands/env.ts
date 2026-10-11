/**
 * `fastagent env add|remove|update|list|install|exec`: the agent's environment, declared under `environment` in
 * context.json and locked in environment/ (docs/design/agent-service.md §4), in the agent directory, the current one.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadEnvironment, readContextFile } from "../../content/file.ts";
import { aptAdvice, missingAptPackages } from "../../environment/apt.ts";
import {
  type DeclaredEnvironment,
  ENVIRONMENT_DIR,
  declareEnvironment,
  declaredVariables,
  parsePackageArgument,
  runtimeAdvice,
  samePackages,
} from "../../environment/declare.ts";
import {
  checkPackages,
  ensureMise,
  enterEnvironment,
  lockEnvironment,
  lockedVersions,
  miseBinary,
  withEnvironmentLock,
} from "../../environment/mise.ts";
import { writeEnvironment } from "../../harnesses/pi/authoring.ts";
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
  const apt: string[] = [];
  await edit(agentDir, (current) => {
    const packages = { ...current.packages };
    const aptPackages = [...current.aptPackages];
    for (const arg of args) {
      const parsed = parsePackageArgument(arg);
      if ("apt" in parsed) {
        apt.push(parsed.apt);
        if (!aptPackages.includes(parsed.apt)) aptPackages.push(parsed.apt);
      } else {
        packages[parsed.name] = parsed.version;
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

export async function runEnvUpdate(names: string[]): Promise<void> {
  const agentDir = enterAgentHere();
  const changes = await withEnvironmentLock(agentDir, async () => {
    const declared = loadEnvironment(agentDir) ?? NONE;
    for (const name of names) {
      if (name.startsWith("apt:")) {
        throw new Error(`${name} is not locked: the image installs the version its Debian release has`);
      }
      if (!Object.hasOwn(declared.packages, name)) throw noPackage(declared, name);
    }
    if (Object.keys(declared.packages).length === 0) throw new Error("the environment declares no packages to update");
    const before = lockedVersions(agentDir);
    await lockEnvironment(agentDir, declared.packages, () => checkedMise(agentDir, declared.packages), names);
    const after = lockedVersions(agentDir);
    return (names.length > 0 ? names : Object.keys(declared.packages)).map(
      (name) => [name, before.get(name), after.get(name)] as const,
    );
  }).catch(failStartup);
  const width = Math.max(...changes.map(([name]) => name.length));
  for (const [name, before, after] of changes) {
    console.log(
      `${name.padEnd(width)}  ${before === after ? `${after} (the newest it allows)` : `${before ?? "(not locked)"} → ${after}`}`,
    );
  }
  if (changes.some(([, before, after]) => before !== after)) {
    log.info(`[fastagent] commit ${ENVIRONMENT_DIR}/; a running \`fastagent dev\` restarts on it`);
  }
}

export async function runEnvList(): Promise<void> {
  const agentDir = enterAgentHere();
  const declared = await Promise.resolve()
    .then(() => loadEnvironment(agentDir) ?? NONE)
    .catch(failStartup);
  const locked = lockedVersions(agentDir);
  const variables = declaredVariables(declared);
  const names = [
    ...Object.keys(declared.packages),
    ...declared.aptPackages.map((name) => `apt:${name}`),
    ...variables.map(({ name }) => name),
  ];
  if (names.length === 0) console.log("(none: the agent runs this machine's commands)");
  const width = Math.max(0, ...names.map((name) => name.length));
  for (const [name, version] of Object.entries(declared.packages)) {
    console.log(`${name.padEnd(width)}  ${version.padEnd(8)}  ${locked.get(name) ?? "(not locked)"}`);
  }
  for (const name of declared.aptPackages) console.log(`${`apt:${name}`.padEnd(width)}  (installed by the image)`);
  // Whether each has a value here, never the value.
  for (const { name, description } of variables) {
    console.log(`${name.padEnd(width)}  ${(process.env[name] ? "set" : "not set").padEnd(8)}  ${description}`);
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

export async function runEnvInstall(): Promise<void> {
  const agentDir = enterAgentHere();
  await withEnvironmentLock(agentDir, async () => {
    const declared = loadEnvironment(agentDir) ?? NONE;
    if (await lockEnvironment(agentDir, declared.packages, () => checkedMise(agentDir, declared.packages))) {
      log.info(
        Object.keys(declared.packages).length > 0
          ? `[fastagent] ${ENVIRONMENT_DIR}/ is locked again from context.json — commit it`
          : `[fastagent] removed ${ENVIRONMENT_DIR}/, which context.json no longer declares — commit the removal`,
      );
    }
    await enterEnvironment(agentDir);
  }).catch(failStartup);
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
 * Change the declaration with `change`, checked as a whole. When its packages change, they are checked, installed here
 * and locked into `environment/` first; the declaration is written last.
 */
async function edit(
  agentDir: string,
  change: (current: DeclaredEnvironment) => DeclaredEnvironment,
): Promise<DeclaredEnvironment> {
  return withEnvironmentLock(agentDir, async () => {
    // Read whole, as the write that follows is: a refused content entry stops the edit before anything is locked.
    const current = readContextFile(agentDir).environment ?? NONE;
    const next = declareEnvironment(change(current)) ?? NONE;
    if (!samePackages(current.packages, next.packages)) {
      await lockEnvironment(agentDir, next.packages, () => checkedMise(agentDir, next.packages));
    }
    await writeEnvironment(agentDir, next);
    return next;
  });
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
