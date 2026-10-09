/**
 * WHAT AN AUTHOR DECLARES an agent works on or knows: the `content` map of `context.json`, read and refused in ONE
 * place (file.ts reads the file through it). Pure: what is at `content/<name>` on this machine is resolve.ts's
 * question. docs/design/agent-model.md §3 is the rule.
 */
import { isAbsolute } from "node:path";
import { isUnderDir } from "../paths.ts";

/** One content entry as `context.json` holds it, under its name. */
export interface ContentEntry {
  /** A repository, `owner/repo`. Without it the entry is a directory each machine links at `content/<name>`. */
  github?: string;
  /** With `github`: the branch, tag or commit to clone. */
  ref?: string;
  /** The agent knows it and does not write it. */
  readonly?: boolean;
  /** One sentence for the agent: what this is, and how to treat it. */
  description?: string;
}

/** A declared entry, read. */
export type DeclaredContent = { name: string; readonly: boolean; description?: string } & (
  | { kind: "local" }
  | { kind: "github"; repo: string; ref?: string }
);

/**
 * The keys an entry carries, in the order they are written: where it comes from, then how it is treated. One list, so
 * a key the reader accepts is one the writer keeps.
 */
const ENTRY_KEYS = ["github", "ref", "readonly", "description"] as const;

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
  const out: Record<string, unknown> = {};
  for (const key of ENTRY_KEYS) if (entry[key] !== undefined) out[key] = entry[key];
  return out as ContentEntry;
}

/** Read the `content` map (undefined is none). Every refusal names the entry; nothing is defaulted silently. */
export function declareContent(raw: unknown): DeclaredContent[] {
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
    return declareOne(name, entry);
  });
}

function declareOne(name: string, entry: unknown): DeclaredContent {
  const at = `content "${name}"`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at} must be an object`);
  const e = entry as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${at}: unknown key "${key}" (valid keys: ${ENTRY_KEYS.join(", ")})`);
    }
  }
  for (const key of ["github", "ref", "description"] as const) {
    if (e[key] !== undefined && (typeof e[key] !== "string" || e[key] === "")) {
      throw new Error(`${at}: "${key}" must be a non-empty string`);
    }
  }
  if (e.readonly !== undefined && typeof e.readonly !== "boolean")
    throw new Error(`${at}: "readonly" must be a boolean`);
  const description = e.description as string | undefined;
  const declared = { name, readonly: e.readonly === true, ...(description !== undefined ? { description } : {}) };
  if (e.github === undefined) {
    if (e.ref !== undefined) throw new Error(`${at}: "ref" applies to a github entry`);
    return { ...declared, kind: "local" };
  }
  const repo = e.github as string;
  if (!isGithubRepo(repo)) throw new Error(`${at}: "github" must be "owner/repo", got "${repo}"`);
  const ref = e.ref as string | undefined;
  // git reads a leading "-" as an option, and no branch, tag or commit name has one.
  if (ref?.startsWith("-")) throw new Error(`${at}: "ref" must name a branch, tag or commit, got "${ref}"`);
  return { ...declared, kind: "github", repo, ...(ref !== undefined ? { ref } : {}) };
}

/**
 * A directory `content/<name>` links to and the agent directory are kept apart (agent-model.md §2): a definition is
 * released, writable content is kept, and one directory cannot be both. The ONE statement of the rule; resolve.ts asks
 * it of the real paths.
 */
export function nestingError(agentDir: string, location: string, name: string): string | undefined {
  if (!isAbsolute(location)) throw new Error(`nestingError: "${location}" is not absolute`);
  if (isUnderDir(agentDir, location)) {
    return (
      `content "${name}" (${location}) contains the agent directory ${agentDir} — an agent lives in a directory of ` +
      `its own: move it out of ${location}, or link other content`
    );
  }
  if (isUnderDir(location, agentDir)) {
    return (
      `content "${name}" (${location}) is inside the agent directory ${agentDir} — content is a directory of its ` +
      `own: move it out, or link other content`
    );
  }
  return undefined;
}
