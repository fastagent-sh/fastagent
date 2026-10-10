/**
 * Creating an agent and editing its content, as an API: `fastagent init` and `fastagent content` are thin CLI wrappers
 * over these, so the CLI and a client (a desktop app) cannot disagree about the rules. Nothing here prints or exits;
 * every refusal is thrown with the message the CLI shows.
 */
import { resolve } from "node:path";
import { resolveAgentDir } from "../../paths.ts";
import { type ScaffoldOptions, initRepository, scaffoldAgent } from "../../scaffold/init.ts";
import { type ContentDeclaration, declareContent, defaultContentName, isContentName } from "../../content/declare.ts";
import { type ResolvedContent, resolveContent } from "../../content/resolve.ts";
import { editContent, loadConfig, writeContent } from "./config.ts";

/**
 * A refusal about a content entry's NAME: one that cannot name an entry, one the agent already has, one it does not have.
 * The caller can fix it by naming another (the CLI exits 2 and asks for `--name`).
 */
export class ContentNameError extends Error {
  override name = "ContentNameError";
}

export interface CreateAgentOptions extends ScaffoldOptions {
  /** What the agent works on and knows, written into `fastagent.config.ts`. */
  content?: ContentDeclaration[];
  /**
   * Install the agent's dependencies, after the scaffold and before its first commit, so the lockfile is in that
   * commit. The CLI passes `npm install` (its scaffold carries web access); without `webAccess` nothing needs
   * installing. A rejection is a failed create: the scaffold is removed again and the error thrown, as when writing
   * the content declaration fails, so the directory is empty for a retry. One that reports its failure some other way (the CLI's
   * resolves, and says the install failed) leaves the agent created.
   */
  install?: (dir: string) => Promise<void>;
}

export interface CreatedAgent {
  /** The agent directory, absolute. */
  dir: string;
  /** The files written, relative to `dir`. */
  created: string[];
  /** The content, resolved for this instance. */
  content: ResolvedContent[];
  /**
   * What became of the agent's git repository, as a sentence to show: created with the scaffold as its first commit,
   * or why not (inside a repository that tracks it, git missing, no commit identity).
   */
  repository: string;
}

/**
 * Create an agent in `dir`, which must be new or empty. Every content entry is checked before anything is written, and the
 * scaffold is removed again when writing the content declaration fails. It runs without `npm install`; with `webAccess`, its web
 * tools load only once `npm install` has installed `@fastagent-sh/pi-web-access`, and until then are left out with a warning. The
 * agent is then a git repository whose first commit is what was written:
 * it changes itself, and version control is how its author goes back to a version that worked.
 */
export async function createAgent(dir: string, options: CreateAgentOptions = {}): Promise<CreatedAgent> {
  const agentDir = resolve(dir);
  const declarations = options.content ?? [];
  for (const [i, declaration] of declarations.entries()) contentName(agentDir, declarations.slice(0, i), declaration);
  const content = resolveContent(agentDir, declarations);
  const { created, undo } = await scaffoldAgent(agentDir, { webAccess: options.webAccess });
  // The content was checked above, so a refusal here is one that check could not foresee (the disk changed in
  // between); the scaffold goes with it, or a retry would find "already an agent" declaring no content.
  if (declarations.length > 0) {
    await writeContent(agentDir, declarations).catch(async (error: unknown) => {
      await undo();
      throw error;
    });
  }
  if (options.install) {
    const install = options.install;
    await install(agentDir).catch(async (error: unknown) => {
      await undo();
      throw error;
    });
  }
  return { dir: agentDir, created, content, repository: await initRepository(agentDir) };
}

/** The agent's content, resolved for this instance (what `fastagent content list` shows). */
export async function listContent(agentDir: string): Promise<ResolvedContent[]> {
  const dir = resolveAgentDir(agentDir);
  return resolveContent(dir, (await loadConfig(dir)).config.content);
}

/** What an edit leaves: the entry it added or removed, by name, and the agent's content after it. */
export interface ContentEdit {
  name: string;
  content: ResolvedContent[];
}

/**
 * Add a content entry to the agent in `agentDir`. It is named `declaration.name`, or after its repository or directory;
 * a name that cannot be one, or that the agent already has (ignoring case), is a {@link ContentNameError}.
 */
export async function addContent(agentDir: string, declaration: ContentDeclaration): Promise<ContentEdit> {
  const dir = resolveAgentDir(agentDir);
  const { name, content } = await editContent(dir, (declared) => {
    const next = [...declared, declaration];
    return { content: next, result: { name: contentName(dir, declared, declaration), content: next } };
  });
  return { name, content: resolveContent(dir, content) };
}

/** Remove the agent's content entry named `name` (ignoring case); a name it does not have is a {@link ContentNameError}. */
export async function removeContent(agentDir: string, name: string): Promise<ContentEdit> {
  const dir = resolveAgentDir(agentDir);
  const removed = await editContent(dir, (declared) => {
    const names = declareContent(declared, dir).map((c) => c.name);
    const index = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    if (index === -1) {
      throw new ContentNameError(`no content named "${name}" (this agent has: ${names.join(", ") || "none"})`);
    }
    const next = declared.filter((_, i) => i !== index);
    return { content: next, result: { name: names[index] as string, content: next } };
  });
  return { name: removed.name, content: resolveContent(dir, removed.content) };
}

/**
 * The name `declaration` takes beside the `declared` ones: its own, or its repository's or directory's. One that cannot
 * name an entry, or that one of them has (ignoring case), is a {@link ContentNameError}.
 */
function contentName(agentDir: string, declared: ContentDeclaration[], declaration: ContentDeclaration): string {
  const name = declaration.name ?? defaultContentName(declaration);
  if (!isContentName(name)) {
    throw new ContentNameError(`"${name}" cannot name content (one path segment of letters, digits, "-" and "_")`);
  }
  const taken = declareContent(declared, agentDir).find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new ContentNameError(`this agent already has content named "${taken.name}"`);
  return name;
}
