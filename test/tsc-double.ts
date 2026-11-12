/**
 * The build's compiler (src/harnesses/pi-durable/tsc.ts) for a unit test whose subject is what the build decides, not
 * what TypeScript does: the program is found by following relative imports, and each file is emitted with Node's type
 * stripping. It checks no types and resolves no package, so a test of a type error or a workspace package stays with the
 * real compiler. Installed with `vi.mock("../src/harnesses/pi-durable/tsc.ts", () => import("./tsc-double.ts"))`;
 * tsc-double.integration.test.ts checks that a build through it writes what a build through `tsc` writes.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import type { CompilerResult, ProjectCompiler } from "../src/harnesses/pi-durable/tsc.ts";

const SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const SCRIPT = /\.(?:[cm]?ts|[cm]?js|json)$/;
const DECLARATION = /\.d\.[cm]?ts$/;

/** Where nodenext finds a relative import: the file named, or the source a `.js` name stands for. */
function resolveImport(from: string, specifier: string): string | undefined {
  const named = resolve(dirname(from), specifier);
  const source = named.replace(/\.([cm]?)js$/, ".$1ts");
  return [named, source].find((file) => existsSync(file) && statSync(file).isFile());
}

async function programOf(dir: string, roots: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  const queue = roots.map((root) => join(dir, root));
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (files.includes(file)) continue;
    files.push(file);
    if (file.endsWith(".json")) continue;
    for (const match of (await readFile(file, "utf8")).matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? "";
      if (!specifier.startsWith(".")) continue;
      const found = resolveImport(file, specifier);
      if (found !== undefined) queue.push(found);
    }
  }
  return files;
}

/** `tsc --rewriteRelativeImportExtensions`: a relative import of a source file names what it is emitted as. */
function rewriteImports(code: string): string {
  return code.replace(SPECIFIER, (whole, ...specifiers: (string | undefined)[]) => {
    const specifier = specifiers.slice(0, 3).find((s) => s !== undefined) ?? "";
    if (!specifier.startsWith(".") || DECLARATION.test(specifier)) return whole;
    return whole.replace(specifier, specifier.replace(/\.([cm]?)ts$/, ".$1js"));
  });
}

export function projectCompiler(dir: string): ProjectCompiler {
  return {
    files: (roots) => programOf(dir, roots),

    async emit(outDir, roots): Promise<CompilerResult> {
      const errors: string[] = [];
      for (const file of await programOf(dir, roots)) {
        const rel = relative(dir, file);
        if (rel.startsWith("..") || DECLARATION.test(file) || !SCRIPT.test(file)) continue;
        const source = await readFile(file, "utf8");
        let emitted = source;
        if (!file.endsWith(".json")) {
          try {
            emitted = rewriteImports(/\.[cm]?ts$/.test(file) ? stripTypeScriptTypes(source) : source);
          } catch (error) {
            errors.push(`${rel}: ${(error as Error).message}`);
            continue;
          }
        }
        const target = join(outDir, rel.replace(/\.([cm]?)ts$/, ".$1js"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, emitted);
      }
      return { code: errors.length > 0 ? 2 : 0, output: errors.join("\n") };
    },

    async declare(outDir, root): Promise<CompilerResult> {
      const target = join(outDir, root.replace(/\.([cm]?)ts$/, ".d.$1ts"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "declare const _default: unknown;\nexport default _default;\n");
      return { code: 0, output: "" };
    },
  };
}
