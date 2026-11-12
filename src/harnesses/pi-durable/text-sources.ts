/**
 * Where an instance's text is: the program's own `skills/` and `prompts/`, then what the
 * instance configuration's `instructions`, `skills` and `prompts` name. Resolved once, at open, into absolute paths, so
 * the readers (text.ts) read exactly these for each message and scan nothing else.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { configurationPath, isUnderDir } from "../../paths.ts";
import type { InstanceConfigSource } from "./config.ts";

export interface TextSource {
  /** Absolute: a file of instructions, or a directory of skills or of prompt templates. */
  path: string;
  /** The instance configuration that declared it, and so expects it to exist. None for the program's own. */
  declaredBy?: string;
  /** The path as the configuration wrote it. */
  given?: string;
}

/** Each kind's sources in the order they load: the program's first, so a later one never replaces its entries. */
export interface TextSources {
  instructions: readonly TextSource[];
  skills: readonly TextSource[];
  prompts: readonly TextSource[];
}

type Kind = keyof TextSources;

export const NOUN = { instructions: "file", skills: "directory", prompts: "directory" } as const;

/** The program's own text, which `AGENTS.md` and `SYSTEM.md` already put in the prompt. */
export function programText(dir: string): TextSources {
  return { instructions: [], skills: [{ path: join(dir, "skills") }], prompts: [{ path: join(dir, "prompts") }] };
}

/** What `path` is: a file, a directory, or nothing. */
export function whatIs(path: string): "file" | "directory" | undefined {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The text of the program in `dir` and of `instance` (whose shape `resolveConfig` has checked): each declared path
 * resolved against the configuration's directory, and refused when it is not what its kind names or is text the
 * program already loads, which would load twice.
 */
export function declareText(dir: string, instance: InstanceConfigSource | undefined): TextSources {
  const program = programText(dir);
  const values = typeof instance?.values === "object" ? (instance.values as Partial<Record<Kind, string[]>>) : {};
  if (instance === undefined) return program;
  const programsOwn = ["SYSTEM.md", "AGENTS.md", "skills", "prompts"].map((name) => join(dir, name));
  const declared = (kind: Kind): TextSource[] =>
    (values[kind] ?? []).map((given) => {
      const at = `${instance.label}: ${kind} "${given}"`;
      const path = configurationPath(given, instance.directory);
      if (path === undefined) {
        throw new Error(
          `${at} must be absolute here, since ${instance.label} is not a file its directory could anchor`,
        );
      }
      if (whatIs(path) !== NOUN[kind]) throw new Error(`${at} (${path}) is not a ${NOUN[kind]}`);
      const own = programsOwn.find((text) => isUnderDir(path, text));
      if (own !== undefined) {
        throw new Error(`${at} (${path}) is the program's own text (${own}), which loads already: declare another`);
      }
      return { path, declaredBy: instance.label, given };
    });
  return {
    instructions: declared("instructions"),
    skills: [...program.skills, ...declared("skills")],
    prompts: [...program.prompts, ...declared("prompts")],
  };
}
