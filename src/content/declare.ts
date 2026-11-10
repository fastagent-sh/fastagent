/**
 * WHAT AN AGENT WORKS ON, declared and refused in ONE place (file.ts reads the files through it): the `content` map of
 * the program's `context.json`, which holds only repositories every instance reaches, and the `content` map of an
 * instance's `fastagent.json`, which adds repositories and directories of its own. An instance only adds: a name the
 * program declares is not one it may take. Pure: what is on the disk is resolve.ts's question.
 * docs/design/agent-artifact.md §3.3 and §4.2 are the rule.
 */
import { CONTEXT_FILE, configurationPath } from "../paths.ts";

/** One content entry as a file holds it, under its name: a repository, or a directory of this machine. */
export type ContentEntry =
  | {
      /** The repository, `owner/repo`. */
      github: string;
      /** The branch, tag or commit to clone. */
      ref?: string;
      /** One sentence for the agent: what this is, and how to treat it. */
      description?: string;
    }
  | {
      /** Absolute, `~/`, or relative to the instance configuration. */
      path: string;
      description?: string;
    };

/** A declared entry, read. */
export type DeclaredContent = {
  name: string;
  description?: string;
  /** The input that declared it. */
  origin: "program" | "instance";
} & (
  | {
      kind: "github";
      /** `owner/repo`. */
      repo: string;
      ref?: string;
    }
  | {
      /** A directory of this machine, `path` absolute. */
      kind: "local";
      path: string;
    }
);

/** Where a `content` map was read from, for what a refusal says and how a path is read. */
export interface ContentSource {
  origin: DeclaredContent["origin"];
  /** The file's name, or what an instance configuration is called. */
  file: string;
  /** What a relative path is relative to: the instance configuration's directory. None for one that is no file. */
  base?: string;
}

/**
 * The keys an entry carries, in the order they are written: where it is, then how it is treated. One list each, so a
 * key the reader accepts is one the writer keeps.
 */
const GITHUB_KEYS = ["github", "ref", "description"] as const;
const PATH_KEYS = ["path", "description"] as const;

/** A name becomes a directory name, so it is one path segment (the spelling a release's agent name has). */
const NAME = /^[A-Za-z0-9_-]+$/;

/** Whether `name` can name a content entry. */
export function isContentName(name: string): boolean {
  return NAME.test(name);
}

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Whether `repo` names a GitHub repository, `owner/repo`. */
export function isGithubRepo(repo: string): boolean {
  return GITHUB_REPO.test(repo);
}

/** `entry` with its keys in the order they are written. */
export function canonicalEntry(entry: ContentEntry): ContentEntry {
  return pick(entry, "github" in entry ? GITHUB_KEYS : PATH_KEYS) as unknown as ContentEntry;
}

function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const field = (value as Record<string, unknown>)[key];
    if (field !== undefined) out[key] = field;
  }
  return out;
}

/**
 * Read a `content` map (undefined is none) from `from`. Every refusal names the entry; nothing is defaulted. The
 * program's declares repositories only, since it is shared; an instance's may name a directory too.
 */
export function declareContent(raw: unknown, from: ContentSource): DeclaredContent[] {
  return entriesByName(raw).map(([name, entry]) => declareOne(name, entry, from));
}

/**
 * The program's entries and the instance's, as one list. An instance only adds: a name both declare (ignoring case,
 * as names are a directory) is refused, naming both, so nothing is shadowed.
 */
export function joinContent(
  program: readonly DeclaredContent[],
  instance: readonly DeclaredContent[],
): DeclaredContent[] {
  for (const added of instance) {
    const taken = program.find((entry) => entry.name.toLowerCase() === added.name.toLowerCase());
    if (taken !== undefined) {
      throw new Error(
        `content "${added.name}" is declared by the program (${CONTEXT_FILE} names "${taken.name}") and by the ` +
          `instance: an instance adds to the program's content and does not replace it — name it otherwise`,
      );
    }
  }
  return [...program, ...instance];
}

/** The entries of a `content` map, each name checked, unique ignoring case. */
function entriesByName(raw: unknown): [string, unknown][] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`"content" must be an object of entries by name`);
  }
  const seen = new Map<string, string>();
  return Object.entries(raw).map(([name, entry]) => {
    if (!NAME.test(name)) {
      throw new Error(`content "${name}": a name is one path segment of letters, digits, "-" and "_"`);
    }
    const key = name.toLowerCase();
    const taken = seen.get(key);
    // Equal ignoring case is the same name: it becomes a directory, and some filesystems do not tell them apart.
    if (taken !== undefined) {
      throw new Error(`two content entries are named "${taken}" and "${name}" — names must differ ignoring case`);
    }
    seen.set(key, name);
    return [name, entry];
  });
}

function objectWithKeys(at: string, value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at} must be an object`);
  const e = value as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (!keys.includes(key)) throw new Error(`${at}: unknown key "${key}" (valid keys: ${keys.join(", ")})`);
  }
  return e;
}

/** `path` as written in an instance configuration, absolute: `~/` is the home directory, a relative one `base`'s. */
function absolutePath(path: string, from: ContentSource, at: string): string {
  const absolute = configurationPath(path, from.base);
  if (absolute === undefined) {
    throw new Error(`${at}: "path" must be absolute here, since ${from.file} is not a file its directory could anchor`);
  }
  return absolute;
}

function declareOne(name: string, entry: unknown, from: ContentSource): DeclaredContent {
  const at = `content "${name}"`;
  const e = objectWithKeys(at, entry, [...GITHUB_KEYS, "path"]);
  if (from.origin === "program" && e.path !== undefined) {
    throw new Error(
      `${at}: ${from.file} is shared, so it declares only the repositories every instance reaches — add a directory ` +
        `to the instance's configuration instead (fastagent content add <dir>)`,
    );
  }
  for (const key of ["github", "ref", "path"] as const) {
    if (e[key] !== undefined && (typeof e[key] !== "string" || e[key] === "")) {
      throw new Error(`${at}: "${key}" must be a non-empty string`);
    }
  }
  if (e.description !== undefined && (typeof e.description !== "string" || e.description === "")) {
    throw new Error(`${at}: "description" must be a non-empty string`);
  }
  const base = {
    name,
    origin: from.origin,
    ...(e.description !== undefined ? { description: e.description as string } : {}),
  };
  if (e.github !== undefined && e.path !== undefined) throw new Error(`${at} names both "github" and "path": give one`);
  if (e.path !== undefined) {
    if (e.ref !== undefined) throw new Error(`${at}: "ref" applies to a repository, and ${at} is a directory`);
    return { ...base, kind: "local", path: absolutePath(e.path as string, from, at) };
  }
  if (e.github === undefined) {
    throw new Error(`${at} needs "github"${from.origin === "instance" ? ' or "path"' : ""}`);
  }
  const repo = e.github as string;
  if (!isGithubRepo(repo)) throw new Error(`${at}: "github" must be "owner/repo", got "${repo}"`);
  const ref = e.ref as string | undefined;
  // git reads a leading "-" as an option, and no branch, tag or commit name has one.
  if (ref?.startsWith("-")) throw new Error(`${at}: "ref" must name a branch, tag or commit, got "${ref}"`);
  return { ...base, kind: "github", repo, ...(ref !== undefined ? { ref } : {}) };
}
