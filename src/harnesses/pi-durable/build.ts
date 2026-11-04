/**
 * `fastagent build` (agent-artifact.md §3.4): a source project compiled into `dist/`, a package that holds everything
 * an open reads and nothing of the machine that built it. The project's own TypeScript compiles it, per file and
 * unbundled, with the options FastAgent sets; the text and resources are copied; the entry is generated, the
 * definition's modules as static imports.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { readMcpConfiguration, MCP_FILE } from "../../mcp/config.ts";
import { AGENT_CONFIG_FILE, CONTEXT_FILE, exists } from "../../paths.ts";
import { readPackageJson } from "../../runtime.ts";
import { HARNESS_PACKAGES } from "../../version.ts";
import { type AgentDefinition, DEFINITION_FORMAT } from "./definition.ts";
import { loadSourceDefinition } from "./open.ts";
import { REGISTRY_KINDS } from "./registry.ts";

const DIST_DIR = "dist";
const STAGING_DIR = join(".fastagent", "build");

const FASTAGENT_PACKAGE = "@fastagent-sh/fastagent";
const CODE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const TEST = /\.(test|spec)\.[a-z]+$/;
/** What never leaves the project, wherever it is: secrets, dependencies, history, the build's own output. */
const NEVER_COPIED = /^(\.env(\..*)?|\.secrets|node_modules|\.git|\.DS_Store)$/;
/** The program's text and data at the project root (§3.4). */
const ROOT_FILES = ["SYSTEM.md", "AGENTS.md", CONTEXT_FILE, MCP_FILE, "README.md"];
const ROOT_DIRS = ["skills", "prompts", "assets"];
const LICENSE = /^LICEN[CS]E(\..*)?$/i;

export interface BuildOptions {
  /** Type-check the project (default). Without it, `tsc --noCheck` only emits. */
  check?: boolean;
}

export interface BuildResult {
  dist: string;
  definition: AgentDefinition;
  /** What the build would publish that the author should look at: a literal credential in `.mcp.json`, say. */
  warnings: string[];
}

export async function buildProject(directory: string, options: BuildOptions = {}): Promise<BuildResult> {
  // The same refusals `dev` makes, before anything is written: a build of a definition that does not open is no build.
  const definition = await loadSourceDefinition(directory);
  const { dir } = definition;
  const dist = join(dir, DIST_DIR);
  // Built apart and moved into place whole: a build that fails leaves the `dist/` before it as it was.
  const staging = join(dir, STAGING_DIR);
  await rm(staging, { recursive: true, force: true });
  try {
    await compile(dir, staging, definition, options.check !== false);
    await copyProgramFiles(dir, staging);
    await writeEntry(staging, definition);
    await writeFile(join(staging, "package.json"), await distPackageJson(dir, definition));
    await rm(dist, { recursive: true, force: true });
    await rename(staging, dist);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { dist, definition, warnings: literalMcpCredentials(dir) };
}

/** The project's `tsc`, by the package's own `bin`: FastAgent does not carry a compiler, as Next.js does not. */
function projectTsc(dir: string): string {
  try {
    const manifest = createRequire(join(dir, "package.json")).resolve("typescript/package.json");
    const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: { tsc?: string } };
    if (bin?.tsc === undefined) throw new Error(`${manifest} has no tsc`);
    return join(dirname(manifest), bin.tsc);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    throw new Error(
      `fastagent build compiles with the project's TypeScript, and ${dir} has none: npm install --save-dev typescript`,
      { cause: error },
    );
  }
}

/** What the compiler is run with: FastAgent sets it, and the author's `tsconfig.json` is the editor's. */
function tscArguments(dir: string, outDir: string, roots: readonly string[], more: readonly string[]): string[] {
  return [
    projectTsc(dir),
    "--ignoreConfig",
    "--pretty",
    "false",
    "--target",
    "es2022",
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--strict",
    "--skipLibCheck",
    "--verbatimModuleSyntax",
    // What `dev` runs is Node's type stripping: the build compiles only what it would run.
    "--erasableSyntaxOnly",
    "--allowImportingTsExtensions",
    "--rewriteRelativeImportExtensions",
    "--resolveJsonModule",
    "--allowJs",
    "--rootDir",
    dir,
    "--outDir",
    outDir,
    ...more,
    ...roots.map((file) => join(dir, file)),
  ];
}

/**
 * The files the compiler would read that `dist/` cannot hold: a source file outside the project. `tsc` reports one
 * (TS6059) yet writes its output beside it, and with `--noCheck` reports nothing and succeeds, so the program's files
 * are listed first and the build refuses before anything is emitted. Dependencies (`node_modules`, the compiler's own
 * libraries) are not the project's source.
 */
async function sourceOutsideProject(dir: string, roots: readonly string[]): Promise<string[]> {
  const { output } = await run(process.execPath, tscArguments(dir, dir, roots, ["--listFilesOnly"]), dir);
  const listed = output.split("\n").map((line) => line.trim());
  return listed.filter((file) => {
    if (!isAbsolute(file) || file.split(sep).includes("node_modules")) return false;
    return relative(dir, file).startsWith("..");
  });
}

/** The configuration and every registered module, compiled with what they import; a type error fails the build. */
async function compile(dir: string, outDir: string, definition: AgentDefinition, check: boolean): Promise<void> {
  const roots = [
    ...((await exists(join(dir, AGENT_CONFIG_FILE))) ? [AGENT_CONFIG_FILE] : []),
    ...REGISTRY_KINDS.flatMap((kind) => definition.registry[kind].map(({ file }) => file)),
  ];
  if (roots.length === 0) return;
  const outside = await sourceOutsideProject(dir, roots);
  if (outside.length > 0) {
    throw new Error(
      `the project imports source from outside ${dir}, which ${DIST_DIR}/ cannot hold: ${outside.join(", ")}`,
    );
  }
  const { code, output } = await run(
    process.execPath,
    tscArguments(dir, outDir, roots, check ? [] : ["--noCheck"]),
    dir,
  );
  if (code !== 0) throw new Error(`tsc refused the project (exit ${code}):\n${output.trim()}`);
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

/**
 * The text and data the definition reads, and the resources beside its code: every file that is not code or a test
 * in each directory the compiler wrote to. A module's resource is relative to the module, so it lands beside it.
 */
async function copyProgramFiles(dir: string, dist: string): Promise<void> {
  for (const name of await readdir(dir)) {
    if (ROOT_FILES.includes(name) || LICENSE.test(name)) await cp(join(dir, name), join(dist, name));
  }
  for (const name of ROOT_DIRS) {
    if (await exists(join(dir, name))) await copyTree(join(dir, name), join(dist, name), () => true);
  }
  const compiled = (await exists(dist)) ? await readdir(dist, { withFileTypes: true }) : [];
  for (const entry of compiled) {
    if (!entry.isDirectory() || ROOT_DIRS.includes(entry.name)) continue;
    await copyTree(join(dir, entry.name), join(dist, entry.name), (file) => !CODE.test(file) && !TEST.test(file));
  }
}

async function copyTree(from: string, to: string, include: (name: string) => boolean): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (NEVER_COPIED.test(entry.name)) continue;
    const source = join(from, entry.name);
    if (entry.isDirectory()) await copyTree(source, join(to, entry.name), include);
    else if (entry.isFile() && include(entry.name)) {
      await mkdir(to, { recursive: true });
      await cp(source, join(to, entry.name));
    }
  }
}

/** `index.js`, the package's default export: the definition, its modules imported statically. */
async function writeEntry(dist: string, definition: AgentDefinition): Promise<void> {
  const emitted = (file: string) => `./${file.replace(/\.(ts|mts)$/, (ext) => (ext === ".mts" ? ".mjs" : ".js"))}`;
  const lines = [
    "// Generated by fastagent build: do not edit.",
    'import { dirname } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `import { defineDefinition } from ${JSON.stringify(FASTAGENT_PACKAGE)};`,
  ];
  const hasConfig = await exists(join(dist, "fastagent.config.js"));
  if (hasConfig) lines.push('import config from "./fastagent.config.js";');
  let index = 0;
  const kinds = REGISTRY_KINDS.map((kind) => {
    const entries = definition.registry[kind].map(({ file, name }) => {
      const local = `m${index++}`;
      lines.push(`import ${local} from ${JSON.stringify(emitted(file))};`);
      return `    { file: ${JSON.stringify(file)}, name: ${JSON.stringify(name)}, value: ${local} },`;
    });
    return `  ${kind}: [\n${entries.map((entry) => `  ${entry}`).join("\n")}${entries.length > 0 ? "\n" : ""}  ],`;
  });
  const source = `${lines.join("\n")}

export default defineDefinition({
  format: ${DEFINITION_FORMAT},
  name: ${JSON.stringify(definition.name)},
  version: ${JSON.stringify(definition.version)},
  dir: dirname(fileURLToPath(import.meta.url)),
  config: ${hasConfig ? "config ?? {}" : "{}"},
  registry: {
${kinds.map((kind) => `  ${kind}`).join("\n")}
  },
});
`;
  await writeFile(join(dist, "index.js"), source);
  await writeFile(
    join(dist, "index.d.ts"),
    `declare const definition: import(${JSON.stringify(FASTAGENT_PACKAGE)}).AgentDefinition;\nexport default definition;\n`,
  );
}

/**
 * The package `dist/` is: the project's name, version and own dependencies, with FastAgent and the pi packages its
 * code imports as peers, so an app that installs several agents holds one copy of each (§3.5).
 */
async function distPackageJson(dir: string, definition: AgentDefinition): Promise<string> {
  const pkg = (await readPackageJson(dir)) as {
    name?: string;
    description?: string;
    license?: string;
    dependencies?: Record<string, string>;
  };
  const peers = new Set([FASTAGENT_PACKAGE, ...HARNESS_PACKAGES]);
  const dependencies: Record<string, string> = {};
  const peerDependencies: Record<string, string> = {};
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    (peers.has(name) ? peerDependencies : dependencies)[name] = range;
  }
  const out = {
    name: pkg.name ?? basename(dir),
    version: definition.version,
    ...(pkg.description === undefined ? {} : { description: pkg.description }),
    ...(pkg.license === undefined ? {} : { license: pkg.license }),
    type: "module",
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    ...(Object.keys(peerDependencies).length > 0 ? { peerDependencies } : {}),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * The header and environment values of `.mcp.json` with no `${VAR}` in them: the format allows a literal credential,
 * and a build publishes the file, so each is said. FastAgent cannot tell a secret from a setting, so it never refuses.
 */
function literalMcpCredentials(dir: string): string[] {
  const warnings: string[] = [];
  for (const [server, config] of Object.entries(readMcpConfiguration(dir).mcpServers)) {
    const [field, entries]: [string, Readonly<Record<string, string>>] =
      config.type === "http" ? ["headers", config.headers ?? {}] : ["env", config.env ?? {}];
    for (const [key, value] of Object.entries(entries)) {
      if (value !== "" && !value.includes("${")) {
        warnings.push(
          `${MCP_FILE} mcpServers.${server}.${field}.${key} is a literal value, and ${DIST_DIR}/ is published: ` +
            `write \${${key.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}} and give the value as a secret`,
        );
      }
    }
  }
  return warnings;
}
