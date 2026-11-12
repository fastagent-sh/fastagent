/**
 * `fastagent build`: a source project compiled into `dist/`, a package that holds everything
 * an open reads and nothing of the machine that built it. The project's own TypeScript compiles it, per file and
 * unbundled, with the options FastAgent sets; the text and resources are copied; the entry is generated, the
 * definition's modules as static imports.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { instanceConfigSchema } from "./config.ts";
import { BUILD_FILE, DIST_DIR, buildRecord, copyFiles, copyPlan } from "./built.ts";
import { declareMcp, literalCredentialAdvice, literalCredentials, relativeCommands } from "../../mcp/config.ts";
import { AGENT_CONFIG_FILE, exists, isUnderDir } from "../../paths.ts";
import { readPackageJson } from "../../runtime.ts";
import { HARNESS_PACKAGES } from "../../version.ts";
import { type AgentDefinition, DEFINITION_FORMAT } from "./definition.ts";
import { loadSourceDefinition } from "./open.ts";
import { REGISTRY_KINDS } from "./registry.ts";
import { type ProjectCompiler, projectCompiler } from "./tsc.ts";

const STAGING_DIR = join(".fastagent", "build");

/** The JSON Schema of an instance's `fastagent.json` for this program: an editor's `$schema`, and the package's own. */
const SCHEMA_FILE = "fastagent.schema.json";
const FASTAGENT_PACKAGE = "@fastagent-sh/fastagent";
/** A declaration file: types only, so the compiler emits nothing for it, wherever it is (a workspace package's). */
const DECLARATION = /\.d\.[cm]?ts$/;

export interface BuildOptions {
  /** Type-check the project (default). Without it, `tsc --noCheck` only emits. */
  check?: boolean;
}

export interface BuildResult {
  dist: string;
  definition: AgentDefinition;
  /** What the build would publish that the author should look at: a literal credential in `mcpServers`, say. */
  warnings: string[];
}

export async function buildProject(directory: string, options: BuildOptions = {}): Promise<BuildResult> {
  // The same refusals `dev` makes, before anything is written: a build of a definition that does not open is no build.
  const definition = await loadSourceDefinition(directory);
  const { dir } = definition;
  await requireModulePackage(dir);
  const dist = join(dir, DIST_DIR);
  // Built apart and moved into place whole: a build that fails leaves the `dist/` before it as it was.
  const staging = join(dir, STAGING_DIR);
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { recursive: true });
    const code = await compile(dir, staging, definition, options.check !== false);
    await copyFiles(dir, staging, await copyPlan(dir, code));
    requireShippedCommands(dir, staging);
    await writeEntry(staging, definition);
    await writeFile(join(staging, "package.json"), await distPackageJson(dir, definition));
    await writeFile(
      join(staging, SCHEMA_FILE),
      `${JSON.stringify(instanceConfigSchema(definition.config.settings), null, 2)}\n`,
    );
    await writeFile(join(staging, BUILD_FILE), await buildRecord(dir, code));
    await rm(dist, { recursive: true, force: true });
    await rename(staging, dist);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { dist, definition, warnings: literalMcpCredentials(dir) };
}

/** The compiler reads a `.ts` file as CommonJS without a package that says otherwise, and refuses its `import`s. */
async function requireModulePackage(dir: string): Promise<void> {
  if (!(await exists(join(dir, "package.json")))) {
    throw new Error(`fastagent build needs ${join(dir, "package.json")}, with "type": "module"`);
  }
  if (((await readPackageJson(dir)) as { type?: unknown }).type !== "module") {
    throw new Error(`fastagent build compiles ES modules: set "type": "module" in ${join(dir, "package.json")}`);
  }
}

/**
 * The source files the compiler reads, split into the project's (relative, what the build records) and those outside
 * it, which `dist/` cannot hold: `tsc` reports one (TS6059) yet writes its output beside it, and with `--noCheck`
 * reports nothing and succeeds, so the files are listed first and the build refuses before anything is emitted.
 * Dependencies (`node_modules`, the compiler's own libraries) and declaration files, which emit nothing, are neither.
 */
async function programFiles(
  compiler: ProjectCompiler,
  dir: string,
  roots: readonly string[],
): Promise<{ inside: string[]; outside: string[] }> {
  const inside: string[] = [];
  const outside: string[] = [];
  for (const file of await compiler.files(roots)) {
    if (!isAbsolute(file) || file.split(sep).includes("node_modules")) continue;
    const rel = relative(dir, file);
    if (rel.startsWith("..")) {
      if (!DECLARATION.test(file)) outside.push(file);
    } else {
      inside.push(rel.split(sep).join("/"));
    }
  }
  return { inside, outside };
}

/**
 * The configuration and every registered module, compiled with what they import; a type error fails the build.
 * Answers the project's source files the compiler read.
 */
async function compile(dir: string, outDir: string, definition: AgentDefinition, check: boolean): Promise<string[]> {
  const roots = [
    ...((await exists(join(dir, AGENT_CONFIG_FILE))) ? [AGENT_CONFIG_FILE] : []),
    ...REGISTRY_KINDS.flatMap((kind) => definition.registry[kind].map(({ file }) => file)),
  ];
  if (roots.length === 0) return [];
  const compiler = projectCompiler(dir);
  const { inside, outside } = await programFiles(compiler, dir, roots);
  if (outside.length > 0) {
    throw new Error(
      `the project imports source from outside ${dir}, which ${DIST_DIR}/ cannot hold: ${outside.join(", ")}`,
    );
  }
  const { code, output } = await compiler.emit(outDir, roots, check);
  if (code !== 0) throw new Error(`tsc refused the project (exit ${code}):\n${output.trim()}`);
  // The configuration's declaration alone: it types the package's entry by the program's settings.
  if (roots.includes(AGENT_CONFIG_FILE)) {
    const declared = await compiler.declare(outDir, AGENT_CONFIG_FILE);
    if (declared.code !== 0) {
      throw new Error(`tsc could not write the declaration of ${AGENT_CONFIG_FILE}:\n${declared.output.trim()}`);
    }
  }
  return inside;
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
  builtWith: ${JSON.stringify(definition.builtWith)},
  name: ${JSON.stringify(definition.name)},
  version: ${JSON.stringify(definition.version)},
${definition.description === undefined ? "" : `  description: ${JSON.stringify(definition.description)},\n`}  dir: dirname(fileURLToPath(import.meta.url)),
  config: ${hasConfig ? "config ?? {}" : "{}"},
  registry: {
${kinds.map((kind) => `  ${kind}`).join("\n")}
  },
});
`;
  await writeFile(join(dist, "index.js"), source);
  const typed = await exists(join(dist, "fastagent.config.d.ts"));
  const fastagent = JSON.stringify(FASTAGENT_PACKAGE);
  await writeFile(
    join(dist, "index.d.ts"),
    typed
      ? `import type { AgentDefinition, SettingsOf } from ${fastagent};\nimport type config from "./fastagent.config.js";\n` +
          `declare const definition: AgentDefinition<SettingsOf<typeof config>>;\nexport default definition;\n`
      : `import type { AgentDefinition } from ${fastagent};\ndeclare const definition: AgentDefinition;\nexport default definition;\n`,
  );
}

/**
 * The package `dist/` is: the project's name, version and own dependencies, with FastAgent and the pi packages its
 * code imports as peers, so an app that installs several agents holds one copy of each.
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
    exports: {
      ".": { types: "./index.d.ts", default: "./index.js" },
      [`./${SCHEMA_FILE}`]: `./${SCHEMA_FILE}`,
    },
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    ...(Object.keys(peerDependencies).length > 0 ? { peerDependencies } : {}),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * A program's stdio command with a path is relative to its package, which in `dev` is the project and after a build is
 * `dist/`, holding only what the build copied. One the build did not copy works in `dev` and is not there on a box, so
 * it is refused here, against what was actually written to `staging`, rather than found when the box starts.
 */
function requireShippedCommands(dir: string, staging: string): void {
  for (const { name, file, command } of relativeCommands(declareMcp(dir))) {
    const inProject = resolve(dir, command);
    const shipped = join(staging, relative(dir, inProject));
    if (isUnderDir(inProject, dir) && existsSync(shipped)) continue;
    const dependency = isUnderDir(inProject, dir) && relative(dir, inProject).split(sep)[0] === "node_modules";
    throw new Error(
      `${file} mcpServers.${name}: the command "${command}" ` +
        (dependency
          ? `is in node_modules, which the box installs for itself and ${DIST_DIR}/ does not hold: run the package by ` +
            `name (\`npx <package>\`) or give the absolute path it has there`
          : existsSync(inProject)
            ? `is not in ${DIST_DIR}/, which holds only what the build copies (assets/, skills/, prompts/ and the ` +
              `resources beside code): move it under assets/`
            : `does not exist in the project`),
    );
  }
}

/** What a build says of a literal credential in the program's `mcpServers`, which the package publishes. */
function literalMcpCredentials(dir: string): string[] {
  return literalCredentials(declareMcp(dir)).map(
    (literal) =>
      `${literal.file} mcpServers.${literal.server}.${literal.field}.${literal.key} is a literal value, and ` +
      `${DIST_DIR}/ is published: ${literalCredentialAdvice(literal)} and give the value as a secret`,
  );
}
