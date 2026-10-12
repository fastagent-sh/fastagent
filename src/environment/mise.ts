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
  MISE_OVERRIDE_CONFIG_FILENAMES: "none",
  MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: "none",
  MISE_PYTHON_COMPILE: "false",
  MISE_NODE_COMPILE: "false",
  MISE_RUBY_COMPILE: "false",
  MISE_ERLANG_COMPILE: "false",
};

/** What mise is given for `packages`: each as `name@version`. The image's layer spells it the same (container.ts). */
function packageSpecs(packages: Record<string, string>): string[] {
  return Object.entries(packages).map(([name, version]) => `${name}@${version}`);
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
 * Install `packages` here: the newest release each declared version allows. `"missing"` installs only those with no
 * install that matches yet, which `mise where` answers without the network: what a start runs, so an agent whose
 * packages are installed starts offline, and keeps the versions it has. `"all"` asks mise for each, which installs a
 * newer release where one is out (`fastagent env install`).
 */
export async function installPackages(
  agentDir: string,
  bin: string,
  packages: Record<string, string>,
  which: "missing" | "all",
): Promise<void> {
  const specs = packageSpecs(packages);
  const wanted =
    which === "all"
      ? specs
      : (
          await Promise.all(
            // A failed `where` is what mise says of a package with no install here; the install that follows reports
            // any other reason it cannot be had.
            specs.map((spec) =>
              runMise(agentDir, bin, ["where", spec], { capture: true, quiet: true }).then(
                () => undefined,
                () => spec,
              ),
            ),
          )
        ).filter((spec): spec is string => spec !== undefined);
  if (wanted.length === 0) return;
  log.info(`[fastagent] installing the agent's packages: ${wanted.join(", ")}`);
  await runMise(agentDir, bin, ["install", "--quiet", ...wanted], { quiet: true });
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
  await installPackages(agentDir, bin, packages, "missing");
  const env = JSON.parse(
    await runMise(agentDir, bin, ["env", "--json", ...packageSpecs(packages)], { capture: true }),
  ) as Record<string, string>;
  Object.assign(process.env, env);
  return declared;
}
