/**
 * `fastagent env add|remove|list|install|exec`: the agent's environment, declared under `environment` in context.json
 * and locked in environment/ (docs/design/agent-service.md §4), in the agent directory, the current one.
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { loadEnvironment } from "../../content/file.ts";
import { aptAdvice, missingAptPackages } from "../../environment/apt.ts";
import {
  type DeclaredEnvironment,
  ENVIRONMENT_DIR,
  declareEnvironment,
  packagesDigest,
  parsePackageArgument,
  runtimeAdvice,
} from "../../environment/declare.ts";
import {
  checkPackages,
  ensureMise,
  enterEnvironment,
  environmentMismatch,
  lockEnvironment,
  lockedVersions,
  miseBinary,
  updateEnvironment,
} from "../../environment/mise.ts";
import { writeEnvironment } from "../../harnesses/pi/authoring.ts";
import { log } from "../../log.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";

const NONE: DeclaredEnvironment = { packages: {}, aptPackages: [] };

export async function runEnvAdd(args: string[]): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
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
    return { packages, aptPackages };
  }).catch(failStartup);
  const missing = missingAptPackages(apt);
  if (missing && missing.length > 0) log.warn(`[fastagent] ${aptAdvice(missing)}`);
}

export async function runEnvRemove(args: string[]): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
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
    return { packages, aptPackages };
  }).catch(failStartup);
}

export async function runEnvUpdate(names: string[]): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
  const changes = await oneAtATime(agentDir, async () => {
    const declared = loadEnvironment(agentDir) ?? NONE;
    for (const name of names) {
      if (name.startsWith("apt:")) {
        throw new Error(`${name} is not locked: the image installs the version its Debian release has`);
      }
      if (!Object.hasOwn(declared.packages, name)) throw noPackage(declared, name);
    }
    if (Object.keys(declared.packages).length === 0) throw new Error("the environment declares no packages to update");
    const bin = await checkedMise(agentDir, declared.packages);
    if (environmentMismatch(agentDir, declared.packages) !== undefined) {
      await lockEnvironment(agentDir, declared.packages, bin);
    }
    const before = lockedVersions(agentDir);
    await updateEnvironment(agentDir, bin, names);
    const after = lockedVersions(agentDir);
    return (names.length > 0 ? names : Object.keys(declared.packages)).map(
      (name) => [name, before.get(name), after.get(name)] as const,
    );
  }).catch(failStartup);
  const width = Math.max(...changes.map(([name]) => name.length));
  for (const [name, before, after] of changes) {
    console.log(
      `${name.padEnd(width)}  ${before === after ? `${after} (the newest it allows)` : `${before} → ${after}`}`,
    );
  }
  if (changes.some(([, before, after]) => before !== after)) {
    log.info(
      `[fastagent] commit ${ENVIRONMENT_DIR}/; a running \`fastagent dev\` uses the new versions from its next restart`,
    );
  }
}

export async function runEnvList(): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
  const declared = await Promise.resolve()
    .then(() => loadEnvironment(agentDir) ?? NONE)
    .catch(failStartup);
  const locked = lockedVersions(agentDir);
  const names = [...Object.keys(declared.packages), ...declared.aptPackages.map((name) => `apt:${name}`)];
  if (names.length === 0) console.log("(none: the agent runs this machine's commands)");
  const width = Math.max(0, ...names.map((name) => name.length));
  for (const [name, version] of Object.entries(declared.packages)) {
    console.log(`${name.padEnd(width)}  ${version.padEnd(8)}  ${locked.get(name) ?? "(not locked)"}`);
  }
  for (const name of declared.aptPackages) console.log(`${`apt:${name}`.padEnd(width)}  (installed by the image)`);
  const stale = environmentMismatch(agentDir, declared.packages);
  if (stale) log.warn(`[fastagent] ${stale}`);
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
}

export async function runEnvInstall(): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
  await oneAtATime(agentDir, async () => {
    const declared = loadEnvironment(agentDir) ?? NONE;
    const stale = environmentMismatch(agentDir, declared.packages) !== undefined;
    const declares = Object.keys(declared.packages).length > 0;
    const bin = declares ? await checkedMise(agentDir, declared.packages) : undefined;
    if (stale) {
      await lockEnvironment(agentDir, declared.packages, bin);
      log.info(
        declares
          ? `[fastagent] ${ENVIRONMENT_DIR}/ is locked again from context.json — commit it`
          : `[fastagent] removed ${ENVIRONMENT_DIR}/, which context.json no longer declares — commit the removal`,
      );
    }
    await enterEnvironment(agentDir);
  }).catch(failStartup);
}

export async function runEnvExec(command: string[]): Promise<void> {
  const agentDir = agentDirOrExit(resolve("."));
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
 * Change the declaration with `change`, checked as a whole. When its packages change (or `environment/` is not their
 * lock), the packages are checked and `environment/` is locked again first, which installs them here; the declaration
 * is written last, so a `dev` that restarts on it finds its lock in place.
 */
async function edit(
  agentDir: string,
  change: (current: DeclaredEnvironment) => DeclaredEnvironment,
): Promise<DeclaredEnvironment> {
  return oneAtATime(agentDir, async () => {
    const current = loadEnvironment(agentDir) ?? NONE;
    const next = declareEnvironment(change(current)) ?? NONE;
    const commit = () => writeEnvironment(agentDir, next);
    const samePackages = packagesDigest(current.packages) === packagesDigest(next.packages);
    if (samePackages && environmentMismatch(agentDir, next.packages) === undefined) {
      await commit();
      return next;
    }
    const bin = Object.keys(next.packages).length > 0 ? await checkedMise(agentDir, next.packages) : undefined;
    await lockEnvironment(agentDir, next.packages, bin, commit);
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

/**
 * One `fastagent env` at a time per agent: two would render `environment/` over each other. The lock is the directory
 * proper-lockfile keeps beside it (`environment.lock`), refreshed while it is held, so a command waits out another's
 * install.
 */
async function oneAtATime<T>(agentDir: string, run: () => Promise<T>): Promise<T> {
  const path = join(agentDir, ENVIRONMENT_DIR);
  let compromised: Error | undefined;
  // `realpath: false`: environment/ may not exist yet.
  const options = { realpath: false, stale: 30_000, onCompromised: (error: Error) => (compromised = error) };
  const release = await lockfile.lock(path, options).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ELOCKED") throw error;
    log.info("[fastagent] waiting for another `fastagent env` on this agent to finish");
    return lockfile.lock(path, { ...options, retries: { forever: true, minTimeout: 200, maxTimeout: 2_000 } });
  });
  let result: T;
  try {
    result = await run();
  } catch (error) {
    // The primary failure is the one to report; a lock that cannot be released cleanly then is secondary.
    await release().catch(() => {});
    throw error;
  }
  // A compromised lock cannot be released cleanly; that, not the release, is what to report.
  await release().catch((error: unknown) => {
    if (!compromised) throw error;
  });
  if (compromised) throw compromised;
  return result;
}
