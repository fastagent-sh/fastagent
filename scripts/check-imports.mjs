/**
 * One import statement per module, per file.
 *
 * Biome has no duplicate-import rule for JS/TS (only CSS's noDuplicateAtImportRules), and typecheck
 * accepts the duplicates happily — so without this the convention holds only as long as everyone
 * remembers it, which is how the 28 occurrences this replaced accumulated in the first place.
 *
 * Splitting `import type {…}` from `import {…}` of the same module counts as a duplicate: the
 * codebase's prevailing form is one statement with inline `type` markers.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const roots = ["src", "test"];
const NAMED_IMPORT = /^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"([^"]+)";/gm;

async function typescriptFiles(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return extname(path) === ".ts" ? [path] : [];
  const nested = await Promise.all(entries.map((entry) => typescriptFiles(resolve(path, entry.name))));
  return nested.flat();
}

const files = (await Promise.all(roots.map((root) => typescriptFiles(resolve(root))))).flat();
const errors = [];

for (const file of files) {
  const source = await readFile(file, "utf8");
  const seen = new Map();
  for (const match of source.matchAll(NAMED_IMPORT)) {
    const module = match[1];
    const line = source.slice(0, match.index).split("\n").length;
    const first = seen.get(module);
    if (first === undefined) seen.set(module, line);
    else errors.push(`${file}:${line}: "${module}" is already imported at line ${first} — merge the two`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} TypeScript files.`);
}
