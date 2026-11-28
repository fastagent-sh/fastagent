/**
 * The registry: every module in `src/tools/` with what it default-exports, so nothing is imported by hand.
 * A file directly in `src/tools/` is a portable tool module, and shared helpers live outside `src/tools/`.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REGISTRY_KINDS = ["tools"] as const;
type RegistryKind = (typeof REGISTRY_KINDS)[number];

/** One module of the definition: where it is, and what it default-exports. */
interface RegisteredModule {
  /** Relative to the agent directory, as the author opens it: `src/tools/weather.ts`. */
  file: string;
  /** The file's name without its extension. */
  name: string;
  value: unknown;
}

export type Registry = Record<RegistryKind, readonly RegisteredModule[]>;

const MODULE = /^([^.][^/]*)\.(ts|mts|js|mjs)$/;
const NOT_A_MODULE = /\.(d|test|spec)\.[a-z]+$/;

/** The module files of one directory of `src/`, sorted so the registry is the same wherever it is generated. */
async function modulesIn(dir: string, subDir: string): Promise<{ file: string; name: string }[]> {
  let names: string[];
  try {
    names = await readdir(join(dir, "src", subDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.toSorted().flatMap((entry) => {
    const match = MODULE.exec(entry);
    return match === null || NOT_A_MODULE.test(entry)
      ? []
      : [{ file: `src/${subDir}/${entry}`, name: match[1] as string }];
  });
}

async function assertNoRemovedExtensionsDir(dir: string): Promise<void> {
  const legacy = await modulesIn(dir, "extensions");
  if (legacy.length > 0) {
    throw new Error(
      `src/extensions/ is removed (${legacy.map(({ file }) => file).join(", ")}): move portable tools to src/tools/ with defineTool() and prompt instructions to SYSTEM.md or AGENTS.md`,
    );
  }
}

/** The module files of the source project in `dir`, project-relative, in the order the registry imports them. */
export async function registryFiles(dir: string): Promise<string[]> {
  return (await Promise.all(REGISTRY_KINDS.map((kind) => modulesIn(dir, kind)))).flatMap((files) =>
    files.map(({ file }) => file),
  );
}

/** Import every module of the source project in `dir`, in the order the files sort, so each opens the same way. */
export async function importRegistry(dir: string): Promise<Registry> {
  await assertNoRemovedExtensionsDir(dir);
  const registry = {} as Record<RegistryKind, RegisteredModule[]>;
  for (const kind of REGISTRY_KINDS) {
    registry[kind] = [];
    for (const { file, name } of await modulesIn(dir, kind)) {
      let value: unknown;
      try {
        value = ((await import(pathToFileURL(join(dir, file)).href)) as { default?: unknown }).default;
      } catch (error) {
        throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      registry[kind].push({ file, name, value });
    }
  }
  return registry;
}
