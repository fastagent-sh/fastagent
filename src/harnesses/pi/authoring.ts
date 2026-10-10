/**
 * Creating an agent and editing its content, as an API: `fastagent init` and `fastagent content` are thin CLI wrappers
 * over these, so the CLI and a client (a desktop app) cannot disagree about the rules. Nothing here prints or exits;
 * every refusal is thrown with the message the CLI shows.
 */
import { lstatSync, statSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { CONTENT_DIRNAME, CONTEXT_FILE, contentEntryPath, resolveAgentDir } from "../../paths.ts";
import { type ScaffoldOptions, initRepository, scaffoldAgent } from "../../scaffold/init.ts";
import {
  type ContentEntry,
  type DeclaredContent,
  canonicalEntry,
  declareContent,
  isContentName,
} from "../../content/declare.ts";
import {
  type ContextFile,
  contextFileText,
  loadContent,
  parseContextFile,
  readContextFile,
} from "../../content/file.ts";
import { linkContent } from "../../content/mount.ts";
import { type ResolvedContent, checkLinkTarget, resolveContent } from "../../content/resolve.ts";
import type { ContentAddition } from "../../content/source.ts";
import { withLockedFile } from "./locked-file.ts";

/** `context.json` is part of the definition, read by whoever reads the agent. */
const CONTEXT_FILE_MODE = 0o644;

/**
 * A refusal about a content entry's NAME: one that cannot name an entry, one the agent already has, one it does not
 * have. The caller can fix it by naming another (the CLI exits 2 and asks for `--name`).
 */
export class ContentNameError extends Error {
  override name = "ContentNameError";
}

export interface CreateAgentOptions extends ScaffoldOptions {
  /** What the agent works on and knows: written into `context.json`, each linked at `content/<name>` when it says so. */
  content?: ContentAddition[];
  /**
   * Install the agent's dependencies, after the scaffold and before its first commit, so the lockfile is in that
   * commit. The CLI passes `npm install` (its scaffold carries web access); without `webAccess` nothing needs
   * installing. A rejection is a failed create: the scaffold is removed again and the error thrown, as when writing
   * the content fails, so the directory is empty for a retry. One that reports its failure some other way (the CLI's
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
 * Create an agent in `dir`, which must be new or empty. Every content entry is checked before anything is written, and
 * the scaffold is removed again when writing the content fails. It runs without `npm install`; with `webAccess`, its
 * web tools load only once `npm install` has installed `@fastagent-sh/pi-web-access`, and until then are left out with
 * a warning. The agent is then a git repository whose first commit is what was written:
 * it changes itself, and version control is how its author goes back to a version that worked.
 */
export async function createAgent(dir: string, options: CreateAgentOptions = {}): Promise<CreatedAgent> {
  const agentDir = resolve(dir);
  const additions = options.content ?? [];
  let entries: Record<string, ContentEntry> = {};
  for (const addition of additions) {
    entries = withAddition(agentDir, { content: entries, declared: declareContent(entries) }, addition).entries;
  }
  const declared = declareContent(entries);
  const { created, undo } = await scaffoldAgent(agentDir, { webAccess: options.webAccess });
  const removeAll = async (error: unknown): Promise<never> => {
    await rm(join(agentDir, CONTENT_DIRNAME), { recursive: true, force: true });
    await rm(join(agentDir, CONTEXT_FILE), { force: true });
    await undo();
    throw error;
  };
  // The content was checked above, so a refusal here is one that check could not foresee (the disk changed in
  // between); the scaffold goes with it, or a retry would find "already an agent" declaring no content.
  if (additions.length > 0) {
    try {
      writeFileAtomic(join(agentDir, CONTEXT_FILE), contextFileText({ content: entries }), CONTEXT_FILE_MODE);
      for (const { name, link } of additions) if (link !== undefined) linkContent(agentDir, name, link);
    } catch (error) {
      await removeAll(error);
    }
  }
  if (options.install) await options.install(agentDir).catch(removeAll);
  const content = resolveContent(agentDir, declared);
  return { dir: agentDir, created, content, repository: await initRepository(agentDir) };
}

/** The agent's content, resolved for this instance (what `fastagent content list` shows). */
export async function listContent(agentDir: string): Promise<ResolvedContent[]> {
  const dir = resolveAgentDir(agentDir);
  return resolveContent(dir, loadContent(dir));
}

/**
 * What an edit leaves: the entry it added or removed, by name, the agent's content after it, and what to tell the
 * user about what was left on this machine.
 */
export interface ContentEdit {
  name: string;
  content: ResolvedContent[];
  notes: string[];
}

/**
 * Add a content entry to the agent in `agentDir`, and link `content/<name>` when the addition names a directory. A
 * name that cannot be one, or that the agent already has (ignoring case), is a {@link ContentNameError}.
 */
export async function addContent(agentDir: string, addition: ContentAddition): Promise<ContentEdit> {
  const dir = resolveAgentDir(agentDir);
  const path = join(dir, CONTEXT_FILE);
  // Asked before the lock as well, so a refusal leaves no context.json on an agent that had none: the lock creates
  // the file it locks.
  withAddition(dir, readContextFile(dir), addition);
  let linked = false;
  let declared: DeclaredContent[];
  try {
    declared = await withLockedFile(
      path,
      async (src) => {
        const file = parseContextFile(src ?? "{}", path);
        const { entries } = withAddition(dir, file, addition);
        if (addition.link !== undefined) {
          linkContent(dir, addition.name, addition.link);
          linked = true;
        }
        return { result: declareContent(entries), next: contextFileText({ ...file, content: entries }) };
      },
      { mode: fileMode(path) },
    );
  } catch (error) {
    // The link goes with a declaration that was not written; otherwise it would stand for nothing.
    if (linked) unlinkSync(contentEntryPath(dir, addition.name));
    throw error;
  }
  return { name: addition.name, content: resolveContent(dir, declared), notes: [] };
}

/**
 * Remove the agent's content entry named `name` (ignoring case), and the link at `content/<name>`. A clone there is
 * left as it is, and said: it may hold the agent's work, and fastagent never deletes a directory in `content/`. A name
 * the agent does not have is a {@link ContentNameError}.
 */
export async function removeContent(agentDir: string, name: string): Promise<ContentEdit> {
  const dir = resolveAgentDir(agentDir);
  const path = join(dir, CONTEXT_FILE);
  // Asked before the lock too, for the same reason as in addContent.
  entryNamed(readContextFile(dir), name);
  const { removed, declared } = await withLockedFile(
    path,
    async (src) => {
      const file = parseContextFile(src ?? "{}", path);
      const removed = entryNamed(file, name);
      const entries = Object.fromEntries(Object.entries(file.content).filter(([key]) => key !== removed));
      const declared = declareContent(entries);
      // What is left is resolved before it is written, so an entry that cannot be refuses the edit rather than
      // failing it once it is made. The removed one is not asked: removing a broken entry is how it is mended.
      resolveContent(dir, declared);
      return {
        result: { removed, declared },
        next: contextFileText({ ...file, content: entries }),
      };
    },
    { mode: fileMode(path) },
  );
  const location = contentEntryPath(dir, removed);
  const found = lstatSync(location, { throwIfNoEntry: false });
  const notes: string[] = [];
  if (found?.isSymbolicLink()) unlinkSync(location);
  else if (found) {
    notes.push(
      `content/${removed} is left as it is: it may hold the agent's work — delete it once nothing in it is needed`,
    );
  }
  return { name: removed, content: resolveContent(dir, declared), notes };
}

/**
 * `file`'s entries with `addition` among them, checked as a whole before anything is written: its name can name an
 * entry and is not taken (ignoring case), the entry is valid, nothing is at `content/<name>` here yet, what it links to
 * can be linked, and every other entry still resolves (one that does not refuses the edit, not fails it once made).
 */
function withAddition(
  agentDir: string,
  file: Pick<ContextFile, "content" | "declared">,
  addition: ContentAddition,
): { entries: Record<string, ContentEntry>; entry: DeclaredContent } {
  const { name } = addition;
  if (!isContentName(name)) {
    throw new ContentNameError(`"${name}" cannot name content (one path segment of letters, digits, "-" and "_")`);
  }
  const taken = file.declared.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new ContentNameError(`this agent already has content named "${taken.name}"`);
  const entries = { ...file.content, [name]: canonicalEntry(addition.entry) };
  const entry = declareContent(entries).find((declared) => declared.name === name) as DeclaredContent;
  if (lstatSync(contentEntryPath(agentDir, name), { throwIfNoEntry: false })) {
    throw new Error(`content/${name} already exists in ${agentDir}: move it away first`);
  }
  if (addition.link !== undefined) checkLinkTarget(agentDir, entry, addition.link);
  resolveContent(agentDir, declareContent(entries));
  return { entries, entry };
}

/** The name of `file`'s entry `name` matches ignoring case; one it does not have is a {@link ContentNameError}. */
function entryNamed(file: Pick<ContextFile, "declared">, name: string): string {
  const found = file.declared.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (found) return found.name;
  const names = file.declared.map((entry) => entry.name);
  throw new ContentNameError(`no content named "${name}" (this agent has: ${names.join(", ") || "none"})`);
}

/** The mode a rewrite of `path` keeps: its own, or the definition's default for a new one. */
function fileMode(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat === undefined ? CONTEXT_FILE_MODE : stat.mode & 0o777;
}
