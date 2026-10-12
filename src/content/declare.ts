/**
 * WHAT AN AUTHOR DECLARES an agent works on or knows, read and refused in ONE place (file.ts reads the files through
 * it): the `content` map of `context.json`, which is shared and so holds only repositories every instance reaches, and
 * the `content` map of `context.local.json`, the directories of this machine it is bound to. Pure: what is on the disk
 * is resolve.ts's question. docs/design/agent-model.md §3 is the rule.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CONTEXT_FILE, LOCAL_CONTEXT_FILE, isUnderDir } from "../paths.ts";

/** One content entry as `context.json` holds it, under its name: a repository. */
export interface ContentEntry {
  /** The repository, `owner/repo`. */
  github: string;
  /** The branch, tag or commit to clone. */
  ref?: string;
  /** The agent knows it and does not write it. */
  readonly?: boolean;
  /** One sentence for the agent: what this is, and how to treat it. */
  description?: string;
}

/** A declared entry, read. */
export interface DeclaredContent {
  name: string;
  /** The context that declares it; undefined for the agent's own (contexts/join.ts sets it). */
  context?: string;
  /** `owner/repo`. */
  repo: string;
  ref?: string;
  readonly: boolean;
  description?: string;
}

/**
 * One binding as `context.local.json` holds it, under its name: a directory of this machine. Under the name of an
 * entry `context.json` declares it is this machine's checkout of that repository, and carries only `path`.
 */
export interface ContentBinding {
  /** Absolute, `~/`, or relative to the agent directory. */
  path: string;
  readonly?: boolean;
  description?: string;
}

/** A binding, read: `path` absolute. */
export type BoundContent = { name: string; path: string } & (
  | {
      /** This machine's checkout of the declared entry of the same name. */
      kind: "checkout";
    }
  | {
      /** A directory only this machine has. */
      kind: "local";
      readonly: boolean;
      description?: string;
    }
);

/** What an agent's content is declared as: the shared declaration, and this machine's bindings. */
export interface ContentDeclaration {
  declared: DeclaredContent[];
  bound: BoundContent[];
}

/**
 * The keys an entry and a binding carry, in the order they are written: where it is, then how it is treated. One list
 * each, so a key the reader accepts is one the writer keeps.
 */
const ENTRY_KEYS = ["github", "ref", "readonly", "description"] as const;
const BINDING_KEYS = ["path", "readonly", "description"] as const;

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

/** `entry` with its keys in {@link ENTRY_KEYS} order: the form written. */
export function canonicalEntry(entry: ContentEntry): ContentEntry {
  return pick(entry, ENTRY_KEYS) as unknown as ContentEntry;
}

/** `binding` with its keys in {@link BINDING_KEYS} order: the form written. */
export function canonicalBinding(binding: ContentBinding): ContentBinding {
  return pick(binding, BINDING_KEYS) as unknown as ContentBinding;
}

function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const field = (value as Record<string, unknown>)[key];
    if (field !== undefined) out[key] = field;
  }
  return out;
}

/** Read `context.json`'s `content` map (undefined is none). Every refusal names the entry; nothing is defaulted. */
export function declareContent(raw: unknown): DeclaredContent[] {
  return entriesByName(raw).map(([name, entry]) => declareOne(name, entry));
}

/**
 * Read `context.local.json`'s `content` map (undefined is none) beside `declared`, with relative paths resolved against
 * `agentDir`. A binding under a declared entry's name is that entry's checkout here; any other is a directory of this
 * machine alone.
 */
export function declareBindings(raw: unknown, declared: readonly DeclaredContent[], agentDir: string): BoundContent[] {
  return entriesByName(raw).map(([name, binding]) => {
    const at = `content "${name}"`;
    const e = objectWithKeys(at, binding, BINDING_KEYS);
    if (typeof e.path !== "string" || e.path === "") throw new Error(`${at}: "path" must be a non-empty string`);
    const path = absolutePath(e.path, agentDir);
    const shared = declared.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (shared !== undefined) {
      if (shared.name !== name) {
        throw new Error(`${at} binds the entry ${CONTEXT_FILE} names "${shared.name}": spell it the same`);
      }
      for (const key of ["readonly", "description"] as const) {
        if (e[key] !== undefined) {
          throw new Error(
            `${at} binds this machine's checkout of the entry ${CONTEXT_FILE} declares, which says "${key}" for ` +
              `every instance: give it only "path"`,
          );
        }
      }
      return { name, path, kind: "checkout" };
    }
    const treatment = treatmentOf(at, e);
    return { name, path, kind: "local", ...treatment };
  });
}

/** `path` as written in `context.local.json`, absolute: `~/` is the home directory, a relative one the agent's. */
function absolutePath(path: string, agentDir: string): string {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return isAbsolute(path) ? resolve(path) : resolve(agentDir, path);
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

function treatmentOf(at: string, e: Record<string, unknown>): { readonly: boolean; description?: string } {
  if (e.description !== undefined && (typeof e.description !== "string" || e.description === "")) {
    throw new Error(`${at}: "description" must be a non-empty string`);
  }
  if (e.readonly !== undefined && typeof e.readonly !== "boolean")
    throw new Error(`${at}: "readonly" must be a boolean`);
  const description = e.description as string | undefined;
  return { readonly: e.readonly === true, ...(description !== undefined ? { description } : {}) };
}

function declareOne(name: string, entry: unknown): DeclaredContent {
  const at = `content "${name}"`;
  const e = objectWithKeys(at, entry, ENTRY_KEYS);
  for (const key of ["github", "ref"] as const) {
    if (e[key] !== undefined && (typeof e[key] !== "string" || e[key] === "")) {
      throw new Error(`${at}: "${key}" must be a non-empty string`);
    }
  }
  const treatment = treatmentOf(at, e);
  if (e.github === undefined) {
    throw new Error(
      `${at} needs "github": ${CONTEXT_FILE} is shared, so it declares only what every instance reaches — bind a ` +
        `directory of this machine in ${LOCAL_CONTEXT_FILE} instead (fastagent content add <dir>)`,
    );
  }
  const repo = e.github as string;
  if (!isGithubRepo(repo)) throw new Error(`${at}: "github" must be "owner/repo", got "${repo}"`);
  const ref = e.ref as string | undefined;
  // git reads a leading "-" as an option, and no branch, tag or commit name has one.
  if (ref?.startsWith("-")) throw new Error(`${at}: "ref" must name a branch, tag or commit, got "${ref}"`);
  return { name, repo, ...(ref !== undefined ? { ref } : {}), ...treatment };
}

/**
 * A directory the agent is bound to and the agent directory are kept apart (agent-model.md §2): a definition is
 * released, writable content is kept, and one directory cannot be both. The ONE statement of the rule; resolve.ts asks
 * it of the real paths.
 */
export function nestingError(agentDir: string, location: string, name: string): string | undefined {
  if (!isAbsolute(location)) throw new Error(`nestingError: "${location}" is not absolute`);
  if (isUnderDir(agentDir, location)) {
    return (
      `content "${name}" (${location}) contains the agent directory ${agentDir} — an agent lives in a directory of ` +
      `its own: move it out of ${location}, or bind other content`
    );
  }
  if (isUnderDir(location, agentDir)) {
    return (
      `content "${name}" (${location}) is inside the agent directory ${agentDir} — content is a directory of its ` +
      `own: move it out, or bind other content`
    );
  }
  return undefined;
}
