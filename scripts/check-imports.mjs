/**
 * One import statement per module, per file.
 *
 * Biome has no duplicate-import rule for JS/TS (only CSS's noDuplicateAtImportRules), and typecheck
 * accepts the duplicates happily — so without this the convention holds only as long as everyone
 * remembers it, which is how the 28 occurrences this replaced accumulated in the first place.
 *
 * Splitting `import type {…}` from `import {…}` of the same module counts as a duplicate: the
 * codebase's prevailing form is one statement with inline `type` markers. Default and namespace
 * imports count too — `import ignore from "ignore"` beside a later `import { x } from "ignore"` is
 * the same duplicate, and the eight default/namespace imports in the tree would otherwise be a hole
 * in exactly the rule this file states.
 *
 * Scaffold bundles are excluded, matching biome.json / tsconfig.json / knip.jsonc: those trees are
 * data copied verbatim into a new agent, not code this repo builds. A style rule the formatter and
 * the compiler both skip must not be enforced here alone.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const roots = ["src", "test"];

/** The two trees other tooling already excludes — `src/scaffold/templates/**` and
 *  `src/channels/*&#47;scaffold/**`, spelled exactly that narrowly. `src/scaffold/*.ts` is the
 *  SCAFFOLDER, ordinary code every other tool checks; excluding the whole `scaffold` name would
 *  quietly drop it. */
const excluded = (path) =>
  path.includes(`${sep}scaffold${sep}templates${sep}`) ||
  new RegExp(`\\${sep}channels\\${sep}[^\\${sep}]+\\${sep}scaffold\\${sep}`).test(path);

/** Any `import … from "module";` — braces, default, namespace, or a mix of them. `[^;]` spans lines,
 *  so a multi-line brace list is one match; an import specifier cannot contain a semicolon. */
const IMPORT_FROM = /^import\s+[^;]*?\s+from\s+"([^"]+)";/gm;

async function typescriptFiles(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    // ENOTDIR is how the recursion learns `path` is a file — the ordinary leaf case. Anything else
    // (EACCES, a root renamed mid-run) would otherwise report "checked everything, found nothing"
    // and exit 0: the check would pass by failing to run.
    if (error.code !== "ENOTDIR") throw error;
    return extname(path) === ".ts" ? [path] : [];
  }
  const nested = await Promise.all(entries.map((entry) => typescriptFiles(resolve(path, entry.name))));
  return nested.flat();
}

const files = (await Promise.all(roots.map((root) => typescriptFiles(resolve(root))))).flat().filter((f) => !excluded(f));
// A roots typo, or a run from the wrong cwd, otherwise looks identical to a clean tree.
if (files.length === 0) throw new Error(`no TypeScript files under ${roots.join(", ")} — wrong cwd, or roots is stale`);

const errors = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  const seen = new Map();
  for (const match of source.matchAll(IMPORT_FROM)) {
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
