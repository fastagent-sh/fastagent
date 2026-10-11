/**
 * RUNNING an agent's environment with mise. The agent carries its own mise, as optional npm dependencies, one package
 * per platform of which npm installs only this machine's: the author installs nothing, and the image's `npm ci`
 * installs the same mise, at the version the lockfile records, that wrote `mise.lock` here. Every run reads only the
 * agent's own `mise.toml`, never the machine's mise configuration or a parent directory's, so what is installed here
 * is what the image installs.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { log } from "../log.ts";
import { detectRuntime, listsFastagent, readPackageJson } from "../runtime.ts";
import { MISE_FILE, readEnvironment } from "./declare.ts";

/** mise's npm package for each platform it publishes one for, by Node's `${platform}-${arch}`. */
const MISE_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@jdxcode/mise-darwin-arm64",
  "darwin-x64": "@jdxcode/mise-darwin-x64",
  "linux-arm64": "@jdxcode/mise-linux-arm64",
  "linux-x64": "@jdxcode/mise-linux-x64",
};

/** Every platform's package: an agent lists them all, so its lockfile has the image's too. */
export const MISE_PACKAGE_NAMES: readonly string[] = Object.values(MISE_PACKAGES);

/** The platforms `deploy` locks for: an image is built for one of them (AgentCore builds linux-arm64). */
const IMAGE_PLATFORMS = ["linux-x64", "linux-arm64"] as const;

/** A path no file can be at, for the mise configuration files an agent's environment must not read. */
const NO_FILE = "/dev/null/none.toml";

/** This machine's mise package; a platform mise publishes none for cannot run an environment. */
function platformPackage(): string {
  const key = `${process.platform}-${process.arch}`;
  const name = MISE_PACKAGES[key];
  if (!name)
    throw new Error(`an agent's environment (${MISE_FILE}) does not run on ${key} yet: mise has no npm package for it`);
  return name;
}

/**
 * The agent's mise on this machine, or undefined when the agent has none installed. Found by its package, not by
 * `node_modules/.bin/mise`: the platform packages all name that bin, and npm drops the link while it skips the
 * other platforms' packages.
 */
export function miseBinary(agentDir: string): string | undefined {
  const require = createRequire(join(resolve(agentDir), "package.json"));
  try {
    return join(dirname(require.resolve(`${platformPackage()}/package.json`)), "bin", "mise");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

/**
 * What every mise run for the agent in `agentDir` is given: only its own `mise.toml` is read (not `.mise.toml`,
 * `mise.local.toml`, `.tool-versions`, a parent directory's or the machine's configuration), and it is trusted, as
 * running the agent already trusts its code. The same values go into the image the agent is deployed in. They are
 * given to these runs alone, never exported to the agent's processes: a mise the agent runs is the machine's, on the
 * machine's configuration and a content repository's own.
 */
function miseIsolation(agentDir: string): Record<string, string> {
  return isolationAt(realpathSync(agentDir));
}

/** {@link miseIsolation} for an agent directory at `realDir`, a path no link leads through. */
export function isolationAt(realDir: string): Record<string, string> {
  return {
    // The file, not the directory: mise trusts by prefix, and a clone under content/ carries its own mise.toml, which
    // would then run unasked.
    MISE_TRUSTED_CONFIG_PATHS: join(realDir, MISE_FILE),
    MISE_CEILING_PATHS: dirname(realDir),
    MISE_GLOBAL_CONFIG_FILE: NO_FILE,
    MISE_SYSTEM_CONFIG_FILE: NO_FILE,
    MISE_OVERRIDE_CONFIG_FILENAMES: MISE_FILE,
    MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: "none",
  };
}

/**
 * Run the agent's mise in its directory with `args`. Its own output goes to this process's stderr, so progress and
 * errors show; `capture` returns its stdout instead of passing it through. A failure says how mise exited.
 */
function runMise(
  agentDir: string,
  bin: string,
  args: readonly string[],
  options: { capture?: boolean; allowExit?: readonly number[] } = {},
): Promise<{ code: number; stdout: string }> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, {
      cwd: agentDir,
      env: { ...process.env, ...miseIsolation(agentDir) },
      stdio: ["inherit", options.capture ? "pipe" : process.stderr, "inherit"],
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (code === 0 || (code !== null && options.allowExit?.includes(code))) done({ code, stdout });
      else fail(new Error(`mise ${args.join(" ")} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

/** Run the agent's mise in its directory with `args` on this terminal, as the author typed them: its exit code. */
export function execMise(agentDir: string, bin: string, args: readonly string[]): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, {
      cwd: agentDir,
      env: { ...process.env, ...miseIsolation(agentDir) },
      stdio: "inherit",
    });
    child.on("error", fail);
    child.on("close", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

/**
 * The command that puts mise into the agent: every platform's package, at the newest version, pinned. When
 * `package.json` already lists it (a fresh clone), the dependencies are installed as they are, never upgraded.
 */
async function addMiseCommand(agentDir: string): Promise<[string, string[]]> {
  const pkg = await readPackageJson(agentDir);
  const { runtime } = detectRuntime(agentDir, pkg);
  if (platformPackage() in (pkg.optionalDependencies ?? {})) {
    return runtime === "bun" ? ["bun", ["install"]] : ["npm", ["install", "--no-audit", "--no-fund"]];
  }
  const packages = MISE_PACKAGE_NAMES.map((name) => `${name}@latest`);
  return runtime === "bun"
    ? ["bun", ["add", "--optional", "--exact", ...packages]]
    : ["npm", ["install", "--save-optional", "--save-exact", "--no-audit", "--no-fund", ...packages]];
}

/**
 * The agent's mise, added to its `package.json` first when it has none: for the commands an author runs to change the
 * environment (`fastagent env`), never for one that runs the agent. A manifest that does not list FastAgent is
 * refused: the mise would make it a code agent, whose image runs the FastAgent its `package.json` lists.
 */
export async function ensureMise(agentDir: string): Promise<string> {
  const found = miseBinary(agentDir);
  if (found) return found;
  if (!listsFastagent(await readPackageJson(agentDir))) {
    throw new Error(
      `${join(agentDir, "package.json")} does not list @fastagent-sh/fastagent — the agent's mise is one of its ` +
        `dependencies, and an agent with dependencies runs the FastAgent they list. Add it first: ` +
        `\`npm install @fastagent-sh/fastagent\` in ${agentDir}`,
    );
  }
  const [command, args] = await addMiseCommand(agentDir);
  log.info(`[fastagent] installing the agent's mise: ${command} ${args.join(" ")}`);
  await new Promise<void>((done, fail) => {
    const child = spawn(command, args, { cwd: agentDir, stdio: ["inherit", process.stderr, "inherit"] });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`${command} ${args[0]} failed (exit ${code})`))));
  });
  const added = miseBinary(agentDir);
  if (!added) throw new Error(`${command} ${args[0]} added mise to ${agentDir}, and it is still not installed`);
  return added;
}

/** What a command that runs the agent says when its environment has no mise to install it with. */
function missingMise(agentDir: string): Error {
  return new Error(
    `${join(agentDir, MISE_FILE)} declares an environment, and the agent has no mise installed — run ` +
      `\`fastagent env install\` in ${agentDir}`,
  );
}

/**
 * Enter the agent's environment, for a process that runs it: install what `mise.toml` declares, and put it on this
 * process's PATH, which every command the agent runs inherits. mise itself is not put there: `fastagent env` is how
 * the environment changes, and checks what it writes. An agent with no `mise.toml` borrows the machine's commands.
 * System packages are the image's to install; one missing here is said, with how to install it.
 */
export async function enterMiseEnvironment(agentDir: string): Promise<void> {
  const declared = readEnvironment(agentDir);
  if (!declared) return;
  const bin = miseBinary(agentDir);
  if (!bin) throw missingMise(agentDir);
  await runMise(agentDir, bin, ["install"]);
  if (declared.packages.length > 0) {
    const status = await runMise(agentDir, bin, ["bootstrap", "packages", "status", "--missing"], {
      capture: true,
      allowExit: [1],
    });
    if (status.code === 1) {
      log.warn(
        `[fastagent] system packages ${MISE_FILE} declares are missing here (the image installs them):\n` +
          `${status.stdout.trimEnd()}\ninstall them with \`fastagent env bootstrap packages apply\``,
      );
    }
  }
  const env = JSON.parse((await runMise(agentDir, bin, ["env", "--json"], { capture: true })).stdout) as Record<
    string,
    string
  >;
  Object.assign(process.env, env);
}

/**
 * Write `mise.lock` for the platforms an image is built for, from the versions this machine resolves with the agent's
 * mise at `bin`, so the image installs what the author runs.
 */
export async function lockEnvironment(agentDir: string, bin: string): Promise<void> {
  await runMise(agentDir, bin, ["lock", "--platform", IMAGE_PLATFORMS.join(",")]);
}
