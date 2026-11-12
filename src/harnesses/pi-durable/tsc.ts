/**
 * The project's TypeScript as `fastagent build` runs it: its own `tsc`, a process per call, with the options FastAgent
 * sets. Apart from the build so a test whose subject is what the build decides can stand in for the compiler
 * (test/tsc-double.ts), which is the slowest thing the build does.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const MIN_TYPESCRIPT = 7;

export interface CompilerResult {
  code: number | null;
  /** What the compiler said, stdout and stderr together. */
  output: string;
}

export interface ProjectCompiler {
  /** Every file the program of `roots` reads, absolute: dependencies and the compiler's own libraries included. */
  files(roots: readonly string[]): Promise<string[]>;
  /** `roots` and what they import, emitted into `outDir` laid out as in the project; `check` type-checks first. */
  emit(outDir: string, roots: readonly string[], check: boolean): Promise<CompilerResult>;
  /** The declaration of `root` alone, into `outDir`. */
  declare(outDir: string, root: string): Promise<CompilerResult>;
}

/** The compiler of the project in `dir`. Refuses, when called, a project without TypeScript 7 or newer. */
export function projectCompiler(dir: string): ProjectCompiler {
  const tsc = async (outDir: string, roots: readonly string[], more: readonly string[]) =>
    run(process.execPath, tscArguments(dir, outDir, roots, more), dir);
  return {
    async files(roots) {
      const { output } = await tsc(dir, roots, ["--listFilesOnly"]);
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    },
    emit: (outDir, roots, check) => tsc(outDir, roots, check ? [] : ["--noCheck"]),
    declare: (outDir, root) => tsc(outDir, [root], ["--declaration", "--emitDeclarationOnly", "--noCheck"]),
  };
}

/** The project's `tsc`, by the package's own `bin`: FastAgent does not carry a compiler, as Next.js does not. */
function projectTsc(dir: string): string {
  try {
    const manifest = createRequire(join(dir, "package.json")).resolve("typescript/package.json");
    const { bin, version } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: { tsc?: string }; version?: string };
    if (bin?.tsc === undefined) throw new Error(`${manifest} has no tsc`);
    // The options the build sets (--ignoreConfig, --erasableSyntaxOnly, --rewriteRelativeImportExtensions) are 7's.
    if (!(Number.parseInt(version ?? "", 10) >= MIN_TYPESCRIPT)) {
      throw new Error(
        `fastagent build needs TypeScript ${MIN_TYPESCRIPT} or newer; ${dir} has ${version ?? "an unknown version"}`,
      );
    }
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

function run(command: string, args: string[], cwd: string): Promise<CompilerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
