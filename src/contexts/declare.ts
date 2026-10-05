/**
 * WHAT AN AUTHOR DECLARES an agent works on or knows (`contexts` in fastagent.config.ts), read and refused in ONE
 * place: the config loader, `fastagent context` and the resolver all go through it. Pure: whether a location exists is
 * resolve.ts's question. docs/design/agent-model.md §3 is the rule.
 */
import { basename, isAbsolute, resolve } from "node:path";
import { isUnderDir } from "../paths.ts";

/** One entry of `contexts`, as an author writes it. */
export type ContextDeclaration =
  | { local: string; copy?: boolean; readonly?: boolean; name?: string }
  | { github: string; ref?: string; local?: string; readonly?: boolean; name?: string };

/** A declaration read: its name settled and its paths absolute. */
export type DeclaredContext = { name: string; readonly: boolean } & (
  | { kind: "local" | "copy"; path: string }
  | { kind: "github"; repo: string; ref?: string; checkout?: string }
);

/** A context's name becomes a directory name, so it is one path segment (the spelling a release's agent name has). */
const NAME = /^[A-Za-z0-9_-]+$/;

/** Whether `name` can name a context. */
export function isContextName(name: string): boolean {
  return NAME.test(name);
}

/**
 * The declaration a command writes for `source`, read the way `init --context` and `fastagent context add` both read
 * it: a directory is a local context an instance on a host gets its own copy of, so the agent stays deployable.
 */
export function declarationFor(
  source: string,
  cwd: string,
  options: { readonly?: boolean; name?: string } = {},
): ContextDeclaration {
  if (source.startsWith("github:")) {
    throw new Error(`github contexts are not supported yet — pass the checkout's directory instead`);
  }
  return {
    local: resolve(cwd, source),
    copy: true,
    ...(options.readonly ? { readonly: true } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
  };
}
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KEYS = ["local", "github", "copy", "readonly", "name", "ref", "path"] as const;

/**
 * Read `contexts` (undefined is none). Every refusal names the entry; nothing is defaulted silently. Paths are
 * absolute or relative to the agent directory, and resolved here, so every reader sees the same location.
 */
export function declareContexts(raw: unknown, agentDir: string): DeclaredContext[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`"contexts" must be an array`);
  const declared = raw.map((entry, i) => declareOne(entry, `contexts[${i}]`, agentDir));
  const seen = new Map<string, string>();
  for (const context of declared) {
    const key = context.name.toLowerCase();
    const taken = seen.get(key);
    // Equal ignoring case is the same name: it becomes a directory, and some filesystems do not tell them apart.
    if (taken !== undefined) {
      throw new Error(`two contexts are named "${taken}" and "${context.name}" — names must differ ignoring case`);
    }
    seen.set(key, context.name);
  }
  return declared;
}

function declareOne(entry: unknown, at: string, agentDir: string): DeclaredContext {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at} must be an object`);
  const e = entry as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      throw new Error(`${at}: unknown key "${key}" (valid keys: local, github, copy, readonly, name, ref)`);
    }
  }
  if (e.path !== undefined) throw new Error(`${at}: "path" (a subdirectory of a repository) is not supported yet`);
  for (const key of ["local", "github", "name", "ref"] as const) {
    if (e[key] !== undefined && (typeof e[key] !== "string" || e[key] === "")) {
      throw new Error(`${at}: "${key}" must be a non-empty string`);
    }
  }
  for (const key of ["copy", "readonly"] as const) {
    if (e[key] !== undefined && typeof e[key] !== "boolean") throw new Error(`${at}: "${key}" must be a boolean`);
  }
  const readonly = e.readonly === true;
  const local = e.local === undefined ? undefined : resolve(agentDir, e.local as string);
  let declared: DeclaredContext;
  let defaultName: string;
  if (e.github !== undefined) {
    const repo = e.github as string;
    if (!GITHUB_REPO.test(repo)) throw new Error(`${at}: "github" must be "owner/repo", got "${repo}"`);
    if (e.copy !== undefined) throw new Error(`${at}: "copy" applies to a local context; a github one is cloned`);
    declared = {
      name: "",
      readonly,
      kind: "github",
      repo,
      ...(e.ref !== undefined ? { ref: e.ref as string } : {}),
      ...(local !== undefined ? { checkout: local } : {}),
    };
    defaultName = repo.slice(repo.indexOf("/") + 1);
  } else if (local !== undefined) {
    if (e.ref !== undefined) throw new Error(`${at}: "ref" applies to a github context`);
    declared = { name: "", readonly, kind: e.copy === true ? "copy" : "local", path: local };
    defaultName = basename(local);
  } else {
    throw new Error(`${at}: declare where it comes from — "local" (a directory) or "github" ("owner/repo")`);
  }
  const name = (e.name as string | undefined) ?? defaultName;
  if (!NAME.test(name)) {
    throw new Error(
      e.name === undefined
        ? `${at}: its default name "${name}" is not one path segment of letters, digits, "-" and "_" — give it a "name"`
        : `${at}: "name" must be one path segment of letters, digits, "-" and "_", got "${name}"`,
    );
  }
  declared.name = name;
  const location = declared.kind === "github" ? declared.checkout : declared.path;
  const nested = location === undefined ? undefined : nestingError(agentDir, location, name);
  if (nested) throw new Error(nested);
  return declared;
}

/**
 * A context and the agent directory are kept apart (agent-model.md §2): a harness is released, a writable context is
 * kept, and one directory cannot be both. The ONE statement of the rule; resolve.ts asks it again of the real paths.
 */
export function nestingError(agentDir: string, location: string, name: string): string | undefined {
  if (!isAbsolute(location)) throw new Error(`nestingError: "${location}" is not absolute`);
  if (isUnderDir(agentDir, location)) {
    return (
      `context "${name}" (${location}) contains the agent directory ${agentDir} — an agent lives in a directory of ` +
      `its own: move it out of ${location}, or declare another context`
    );
  }
  if (isUnderDir(location, agentDir)) {
    return (
      `context "${name}" (${location}) is inside the agent directory ${agentDir} — a context is a directory of its ` +
      `own: move it out, or declare another`
    );
  }
  return undefined;
}
