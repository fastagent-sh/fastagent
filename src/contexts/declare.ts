/**
 * WHICH CONTEXTS an agent uses: the `contexts` map of its `context.json`, read and refused in ONE place (file.ts reads
 * the file through it). Pure: fetching one is fetch.ts's. docs/design/agent-service.md §3.6 is the rule.
 */
import { isContentName, isGithubRepo } from "../content/declare.ts";
import { CONTEXTS_DIRNAME, CONTEXT_FILE } from "../paths.ts";

/** One context as an agent's `context.json` holds it, under its name. */
export interface ContextEntry {
  /** The repository, `owner/repo`, whose `context.json` the context is. */
  github: string;
  /** A branch or a tag, which the context follows, or a full commit, which pins it. The default branch when unset. */
  ref?: string;
}

/** A context, read. */
export interface DeclaredContext {
  name: string;
  /** `owner/repo`. */
  repo: string;
  ref?: string;
}

/** The keys an entry carries, in the order they are written: one list, so a key the reader accepts the writer keeps. */
const ENTRY_KEYS = ["github", "ref"] as const;

/** `entry` with its keys in {@link ENTRY_KEYS} order: the form written. */
export function canonicalContextEntry(entry: ContextEntry): ContextEntry {
  return entry.ref === undefined ? { github: entry.github } : { github: entry.github, ref: entry.ref };
}

/** Read the `contexts` map (undefined is none). Every refusal names the context; nothing is defaulted. */
export function declareContexts(raw: unknown): DeclaredContext[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`"contexts" must be an object of contexts by name`);
  }
  const seen = new Map<string, string>();
  return Object.entries(raw).map(([name, entry]) => {
    const at = `context "${name}"`;
    // A name becomes a directory name, `.contexts/<name>`, so it follows content's rule.
    if (!isContentName(name)) throw new Error(`${at}: a name is one path segment of letters, digits, "-" and "_"`);
    const taken = seen.get(name.toLowerCase());
    if (taken !== undefined) {
      throw new Error(`two contexts are named "${taken}" and "${name}" — names must differ ignoring case`);
    }
    seen.set(name.toLowerCase(), name);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${at} must be { "github": "owner/repo" }, with an optional "ref"`);
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${at}: unknown key "${key}" (valid keys: ${ENTRY_KEYS.join(", ")})`);
      }
    }
    if (typeof e.github !== "string" || !isGithubRepo(e.github)) {
      throw new Error(`${at}: "github" must be "owner/repo", got ${JSON.stringify(e.github)}`);
    }
    if (e.ref !== undefined && (typeof e.ref !== "string" || e.ref === "")) {
      throw new Error(`${at}: "ref" must be a non-empty string`);
    }
    const ref = e.ref as string | undefined;
    // git reads a leading "-" as an option, and no branch, tag or commit name has one.
    if (ref?.startsWith("-")) throw new Error(`${at}: "ref" must name a branch, tag or commit, got "${ref}"`);
    return { name, repo: e.github, ...(ref !== undefined ? { ref } : {}) };
  });
}

/** Where the context `name`'s own `context.json` is, relative to the agent directory: how every report names it. */
export function contextSource(name: string): string {
  return `${CONTEXTS_DIRNAME}/${name}/${CONTEXT_FILE}`;
}
