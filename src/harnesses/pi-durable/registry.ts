/**
 * The registry (architecture.md §3): every module in `src/tools/`, `src/extensions/`, `src/channels/` and
 * `src/schedules/` with what it default-exports, so nothing is imported by hand. A file directly in the directory is a
 * module, and anything else a module imports (a helper) lives outside these directories.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REGISTRY_KINDS = ["tools", "extensions", "channels", "schedules"] as const;
type RegistryKind = (typeof REGISTRY_KINDS)[number];

/** One module of the definition: where it is, and what it default-exports. */
interface RegisteredModule {
  /** Relative to the agent directory, as the author opens it: `src/tools/weather.ts`. */
  file: string;
  /** The file's name without its extension: a schedule's name. */
  name: string;
  value: unknown;
}

export type Registry = Record<RegistryKind, readonly RegisteredModule[]>;

const MODULE = /^([^.][^/]*)\.(ts|mts|js|mjs)$/;
const NOT_A_MODULE = /\.(d|test|spec)\.[a-z]+$/;

/** The module files of one directory of `src/`, sorted so the registry is the same wherever it is generated. */
async function modulesIn(dir: string, kind: RegistryKind): Promise<{ file: string; name: string }[]> {
  let names: string[];
  try {
    names = await readdir(join(dir, "src", kind));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.sort().flatMap((entry) => {
    const match = MODULE.exec(entry);
    return match === null || NOT_A_MODULE.test(entry)
      ? []
      : [{ file: `src/${kind}/${entry}`, name: match[1] as string }];
  });
}

/** Import every module of the source project in `dir`, in the order the files sort, so each opens the same way. */
export async function importRegistry(dir: string): Promise<Registry> {
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
