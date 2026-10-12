/**
 * RUNNING an agent's environment with mise. The agent carries its own mise, as optional npm dependencies, one package
 * per platform of which npm installs only this machine's: the author installs nothing, and the image's `npm ci`
 * installs the same mise. mise is given the packages as arguments (`gh@2`), and never reads a configuration file: not
 * the machine's, not an author's own `mise.toml`, not a parent directory's.
 *
 * Nothing is locked. Each place installs the newest release a declared version allows when it first needs a package,
 * and keeps it: a process that runs the agent installs only what has no install matching it yet (the image installs
 * every package when it is built), and `fastagent env install` installs the newest again.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { loadEnvironment } from "../content/file.ts";
import { log } from "../log.ts";
import { detectRuntime, listsFastagent, readPackageJson } from "../runtime.ts";
import { aptAdvice, missingAptPackages } from "./apt.ts";
import {
  type DeclaredEnvironment,
  type MissingRuntime,
  missingPythonRuntime,
  resolvedBackendRefusal,
  writtenBackend,
} from "./declare.ts";

/** mise's npm package for each platform it publishes one for, by Node's `${platform}-${arch}`. */
const MISE_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@jdxcode/mise-darwin-arm64",
  "darwin-x64": "@jdxcode/mise-darwin-x64",
  "linux-arm64": "@jdxcode/mise-linux-arm64",
  "linux-x64": "@jdxcode/mise-linux-x64",
};

/** Every platform's package: an agent lists them all, so its lockfile has the image's too. */
export const MISE_PACKAGE_NAMES: readonly string[] = Object.values(MISE_PACKAGES);

/** A path no file can be at, for the mise configuration files an agent's environment must not read. */
const NO_FILE = "/dev/null/none.toml";

/** This machine's mise package; a platform mise publishes none for cannot run an environment. */
function platformPackage(): string {
  const key = `${process.platform}-${process.arch}`;
  const name = MISE_PACKAGES[key];
  if (!name) throw new Error(`an agent's environment does not run on ${key} yet: mise has no npm package for it`);
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
 * What every run of the agent's mise is given, here and in the image: no configuration file is read, so the packages
 * are the arguments alone, and a runtime is installed from a prebuilt release or not at all (mise compiles python by
 * default, and `all_compile`, already false, does not stop it). Given to these runs alone, never exported to the
 * agent's processes: a mise the agent runs is the machine's.
 */
export const MISE_ENVIRONMENT: Readonly<Record<string, string>> = {
  MISE_GLOBAL_CONFIG_FILE: NO_FILE,
  MISE_SYSTEM_CONFIG_FILE: NO_FILE,
  // A path, not a name: mise looks for a file of the name given here in every directory up to the root.
  MISE_OVERRIDE_CONFIG_FILENAMES: NO_FILE,
  MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: NO_FILE,
  MISE_PYTHON_COMPILE: "false",
  MISE_NODE_COMPILE: "false",
  MISE_RUBY_COMPILE: "false",
  MISE_ERLANG_COMPILE: "false",
};

/** What mise is given for `packages`: each as `name@version`, here and in the image (container.ts). */
export function packageSpecs(packages: Record<string, string>): string[] {
  return Object.keys(packages).map((name) => specOf(name, packages));
}

/** How mise is given the package `name` of `packages`. */
function specOf(name: string, packages: Record<string, string>): string {
  return `${name}@${packages[name]}`;
}

/**
 * Run the agent's mise with `args` in `cwd`. Its errors go to this process's stderr unless `quiet` keeps them for
 * the error, which then says what mise said; `capture` returns its stdout instead of passing it through.
 */
function runMise(
  cwd: string,
  bin: string,
  args: readonly string[],
  options: { capture?: boolean; quiet?: boolean } = {},
): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...MISE_ENVIRONMENT },
      stdio: ["inherit", options.capture ? "pipe" : process.stderr, options.quiet ? "pipe" : "inherit"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (code === 0) return done(stdout);
      const said = stderr.match(/ERROR\s+(.+)/)?.[1];
      fail(new Error(`mise ${args.join(" ")} failed (${signal ?? `exit ${code}`})${said ? `: ${said}` : ""}`));
    });
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

/** What the packages need before they are installed: refusals, and a PyPI package's undeclared runtime. */
export interface PackageCheck {
  /** Registry names that resolve to a backend FastAgent leaves out. */
  refusals: string[];
  runtime?: MissingRuntime;
}

/**
 * Check `packages` against the backend each resolves to: a written one says it (`npm:prettier`), and mise resolves a
 * registry name (`tokei` is `cargo:tokei`). A name mise does not know fails the check with what mise said.
 */
export async function checkPackages(
  agentDir: string,
  bin: string,
  packages: Record<string, string>,
): Promise<PackageCheck> {
  const kinds = new Map<string, string>();
  const refusals: string[] = [];
  await Promise.all(
    Object.keys(packages).map(async (name) => {
      const written = writtenBackend(name);
      if (written) return void kinds.set(name, written);
      const out = await runMise(agentDir, bin, ["tool", name, "--json"], { capture: true, quiet: true });
      const backend = (JSON.parse(out) as { backend?: unknown }).backend;
      if (typeof backend !== "string") throw new Error(`mise tool ${name} --json reported no backend`);
      kinds.set(name, backend.split(":")[0] ?? backend);
      const refusal = resolvedBackendRefusal(name, backend);
      if (refusal) refusals.push(refusal);
    }),
  );
  const runtime = missingPythonRuntime(packages, kinds);
  return { refusals: refusals.sort(), ...(runtime ? { runtime } : {}) };
}

/**
 * Install `packages` here, each at the newest release its declared version allows. Those `newest` names (every one
 * when it is `"all"`: `fastagent env install`) are given to mise whatever is installed, which installs a newer release
 * where one is out; the rest only when nothing installed matches them, which `mise where` answers without the network,
 * so a start whose packages are installed needs no network and keeps the versions it has. An install that matches may
 * be another project's: mise's data directory is the machine's.
 */
export async function installPackages(
  agentDir: string,
  bin: string,
  packages: Record<string, string>,
  newest: readonly string[] | "all" = [],
): Promise<void> {
  const names = Object.keys(packages);
  const asked = names.filter((name) => newest === "all" || newest.includes(name));
  const others = names.filter((name) => !asked.includes(name));
  const installed = await Promise.all(
    // A failed `where` is what mise says of a package with no install here; the install that follows reports any other
    // reason it cannot be had.
    others.map((name) =>
      runMise(agentDir, bin, ["where", specOf(name, packages)], { capture: true, quiet: true }).then(
        () => true,
        () => false,
      ),
    ),
  );
  const present = new Set(others.filter((_, i) => installed[i]));
  const wanted = names.filter((name) => !present.has(name)).map((name) => specOf(name, packages));
  if (wanted.length === 0) return;
  const installedSpecs = [...present].map((name) => specOf(name, packages));
  // A package installs with the ones it needs (a PyPI one runs uv), which mise finds in the packages it is given or on
  // the PATH. The installed ones go on the PATH: given as packages, mise would install a newer release of them.
  await runInstall(
    agentDir,
    bin,
    wanted,
    installedSpecs.length > 0 ? await packagesEnvironment(agentDir, bin, installedSpecs) : {},
  );
}

/** What `mise env` puts in a process's environment for `specs`: the PATH their commands are on. */
async function packagesEnvironment(agentDir: string, bin: string, specs: string[]): Promise<Record<string, string>> {
  return JSON.parse(await runMise(agentDir, bin, ["env", "--json", ...specs], { capture: true })) as Record<
    string,
    string
  >;
}

/**
 * The notice mise prints after installing a package no configuration file names, with the `mise use` it suggests: not
 * the agent's way to a package, so it is not passed on.
 */
const NOT_ACTIVATED = /installed but not activated|^To install and activate, run:|^\s+mise use /;

/**
 * `mise install` of `specs`, with `env` added to its environment. Its progress is passed on to this process's stderr as
 * it comes, so a runtime that takes minutes is seen to; a failure carries what mise said, every line of it, since
 * mise names the packages on its first line and the reason (a 404, a proxy, a rate limit) on the lines after.
 */
function runInstall(agentDir: string, bin: string, specs: string[], env: Record<string, string>): Promise<void> {
  log.info(`[fastagent] installing the agent's packages: ${specs.join(", ")}`);
  return new Promise((done, fail) => {
    const child = spawn(bin, ["install", ...specs], {
      cwd: agentDir,
      env: { ...process.env, ...env, ...MISE_ENVIRONMENT },
      stdio: ["inherit", process.stderr, "pipe"],
    });
    const said: string[] = [];
    let partial = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (NOT_ACTIVATED.test(line)) continue;
        process.stderr.write(`${line}\n`);
        said.push(line);
      }
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (partial !== "") said.push(partial);
      if (code === 0) return done();
      const reason = said
        .slice(
          Math.max(
            0,
            said.findIndex((line) => /\bERROR\b/.test(line)),
          ),
        )
        .filter((line) => !/ERROR\s+(Version:|Run with --verbose)/.test(line))
        .map((line) => line.replace(/^mise\s+ERROR\s+/, "").trim())
        .filter((line) => line !== "");
      fail(
        new Error(
          `mise install ${specs.join(" ")} failed (${signal ?? `exit ${code}`})${reason.length > 0 ? `: ${reason.join("; ")}` : ""}`,
        ),
      );
    });
  });
}

/** What a process that runs the agent says when its environment has no mise to install it with. */
function missingMise(agentDir: string): Error {
  return new Error(
    `context.json declares packages, and the agent has no mise installed — run \`fastagent env install\` in ${agentDir}`,
  );
}

/**
 * Enter the agent's environment, for a process that runs it: install the declared packages that have no install here
 * yet, and put them first on this process's PATH, which every command the agent runs inherits. mise itself is not put
 * on the PATH. An agent without packages borrows the machine's commands. Apt packages are the image's to install; one
 * missing here is said, with how.
 */
export async function enterEnvironment(agentDir: string): Promise<DeclaredEnvironment | undefined> {
  const declared = loadEnvironment(agentDir);
  const missingApt = missingAptPackages(declared?.aptPackages ?? []);
  if (missingApt && missingApt.length > 0) log.warn(`[fastagent] ${aptAdvice(missingApt)}`);
  const packages = declared?.packages ?? {};
  if (Object.keys(packages).length === 0) return declared;
  const bin = miseBinary(agentDir);
  if (!bin) throw missingMise(agentDir);
  await installPackages(agentDir, bin, packages);
  Object.assign(process.env, await packagesEnvironment(agentDir, bin, packageSpecs(packages)));
  return declared;
}
