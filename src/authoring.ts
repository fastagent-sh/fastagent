/**
 * Creating an agent and editing its content: `fastagent init` and `fastagent content` are thin wrappers over these (and
 * `fastagent env` writes its declaration through {@link writeEnvironment}), so the rules live here, not in a command.
 * Nothing here prints or exits; every refusal is thrown with the message the CLI shows. The package exports
 * {@link createAgent} and the content edits ({@link addContent}, {@link removeContent}, {@link listContent}), which
 * give an agent its own entries, without an alias prefix; the environment's edit is not exported.
 */
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { GitNotInstalled, gitFor } from "./git.ts";
import { CONTEXT_FILE, LOCAL_CONTEXT_FILE, contentEntryPath, resolveAgentDir } from "./paths.ts";
import { initRepository, scaffoldAgent } from "./scaffold/init.ts";
import {
  type BoundContent,
  type ContentBinding,
  type ContentDeclaration,
  type ContentEntry,
  canonicalBinding,
  canonicalEntry,
  declareBindings,
  declareContent,
  isContentName,
} from "./content/declare.ts";
import {
  type ContextFile,
  type LocalContextFile,
  contextFileText,
  loadContent,
  localContextFileText,
  parseContextFile,
  parseLocalContextFile,
} from "./content/file.ts";
import type { DeclaredEnvironment } from "./environment/declare.ts";
import { type ResolvedContent, checkBinding, contentAbsentHere, resolveContent } from "./content/resolve.ts";
import type { ContentAddition } from "./content/source.ts";
import { type LockResult, withLockedFile } from "./locked-file.ts";

/** `context.json` is part of the definition, read by whoever reads the agent. */
const CONTEXT_FILE_MODE = 0o644;

/**
 * A refusal about a content entry's NAME: one that cannot name an entry, one the agent already has, one it does not
 * have. The caller can fix it by naming another (the CLI exits 2 and asks for `--name`).
 */
export class ContentNameError extends Error {
  override name = "ContentNameError";
}

export interface InitAgentOptions {
  /** What the agent works on: repositories into `context.json`, this machine's directories into
   *  `context.local.json`. */
  content?: ContentAddition[];
  /**
   * Install the agent's dependencies, after the scaffold and before its first commit, so the lockfile is in that
   * commit; the agent's code imports them. A rejection is a failed create: the scaffold is removed again and the error
   * thrown, as when writing the content fails, so the directory is empty for a retry. One that reports its failure
   * some other way (the CLI's resolves, and says the install failed) leaves the agent created.
   */
  install?: (dir: string) => Promise<void>;
}

export interface CreatedAgent {
  /** The agent directory, absolute. */
  dir: string;
  /** The files written, relative to `dir`. */
  created: string[];
  /**
   * What became of the agent's git repository, as a sentence to show: created with the scaffold as its first commit,
   * or why not (inside a repository that tracks it, git missing, no commit identity).
   */
  repository: string;
}

/** The two content maps an edit rewrites, as written: `context.json`'s entries and `context.local.json`'s bindings. */
interface ContentMaps {
  content: Record<string, ContentEntry>;
  bindings: Record<string, ContentBinding>;
}

/**
 * Create an agent in `dir` as `fastagent init` does, which must be new or empty: the whole scaffold, and a git
 * repository whose first commit is what was written, since the agent changes itself and version control is how its
 * author goes back to a version that worked. It installs no dependencies; the agent opens without them.
 *
 * `content` gives it any number of entries, each a directory of this machine or a GitHub repository. They are all
 * checked before anything is written, and one that is refused leaves no directory. Two entries may bind the same
 * directory, or one inside the other; the agent then reaches it by both names.
 */
export async function createAgent(
  dir: string,
  options: { content?: ContentAddition[] } = {},
): Promise<CreatedAgent & { content: ResolvedContent[] }> {
  return initAgent(dir, options.content === undefined ? {} : { content: options.content });
}

/**
 * {@link createAgent} with what `fastagent init` adds: the install. Every content entry is checked before
 * anything is written, and the scaffold is removed again when writing the content fails.
 */
export async function initAgent(
  dir: string,
  options: InitAgentOptions = {},
): Promise<CreatedAgent & { content: ResolvedContent[] }> {
  const agentDir = resolve(dir);
  const additions = options.content ?? [];
  let maps: ContentMaps = { content: {}, bindings: {} };
  for (const addition of additions) maps = withAddition(agentDir, maps, addition).maps;
  const { created, undo } = await scaffoldAgent(agentDir);
  const removeAll = async (error: unknown): Promise<never> => {
    await rm(join(agentDir, CONTEXT_FILE), { force: true });
    await rm(join(agentDir, LOCAL_CONTEXT_FILE), { force: true });
    await undo();
    throw error;
  };
  // The content was checked above, so a refusal here is one that check could not foresee (the disk changed in
  // between); the scaffold goes with it, or a retry would find "already an agent" declaring no content.
  try {
    if (Object.keys(maps.content).length > 0) {
      writeFileAtomic(join(agentDir, CONTEXT_FILE), contextFileText({ content: maps.content }), CONTEXT_FILE_MODE);
    }
    if (Object.keys(maps.bindings).length > 0) {
      writeFileAtomic(join(agentDir, LOCAL_CONTEXT_FILE), localContextFileText(maps.bindings), CONTEXT_FILE_MODE);
    }
  } catch (error) {
    await removeAll(error);
  }
  if (options.install) await options.install(agentDir).catch(removeAll);
  const content = resolveContent(agentDir, declarationOf(agentDir, maps));
  return { dir: agentDir, created, content, repository: await initRepository(agentDir) };
}

/**
 * The agent's content, resolved for this instance (what `fastagent content list` shows), and the directories this
 * machine binds that are not here: the agent is not told of those.
 */
export async function listContent(agentDir: string): Promise<{ content: ResolvedContent[]; absent: BoundContent[] }> {
  const dir = resolveAgentDir(agentDir);
  const declaration = loadContent(dir);
  return { content: resolveContent(dir, declaration), absent: contentAbsentHere(declaration) };
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
 * Add a content entry to the agent in `agentDir`: its repository to `context.json`, its directory on this machine to
 * `context.local.json`, or both. A name that cannot be one, or that the agent already has (ignoring case), is a
 * {@link ContentNameError}.
 */
export async function addContent(agentDir: string, addition: ContentAddition): Promise<ContentEdit> {
  const dir = resolveAgentDir(agentDir);
  const declaration = await editContext(dir, (shared, local) => {
    const { maps } = withAddition(dir, mapsOf(shared, local), addition);
    return {
      result: declarationOf(dir, maps),
      ...(addition.entry !== undefined ? { shared: contextFileText({ ...shared, content: maps.content }) } : {}),
      ...(addition.binding !== undefined ? { local: localContextFileText(maps.bindings) } : {}),
    };
  });
  const notes = addition.binding !== undefined ? unignoredLocalFile(dir) : [];
  return { name: addition.name, content: resolveContent(dir, declaration), notes };
}

/**
 * Remove the agent's content entry named `name` (ignoring case), from `context.json` and from this machine's
 * `context.local.json`. A clone at `content/<name>` is left as it is, and said: it may hold the agent's work, and
 * fastagent never deletes a directory in `content/`. A name the agent does not have is a {@link ContentNameError}.
 */
export async function removeContent(agentDir: string, name: string): Promise<ContentEdit> {
  const dir = resolveAgentDir(agentDir);
  const { removed, wasDeclared, declaration } = await editContext(dir, (shared, local) => {
    const found = entryNamed(mapsOf(shared, local), name);
    const maps = {
      content: without(shared.content, found.name),
      bindings: without(local.content, found.name),
    };
    const declaration = declarationOf(dir, maps);
    // What is left is resolved before it is written, so an entry that cannot be refuses the edit rather than failing
    // it once it is made. The removed one is not asked: removing a broken entry is how it is mended.
    resolveContent(dir, declaration);
    return {
      result: { removed: found.name, wasDeclared: found.shared, declaration },
      ...(found.shared ? { shared: contextFileText({ ...shared, content: maps.content }) } : {}),
      ...(found.local ? { local: localContextFileText(maps.bindings) } : {}),
    };
  });
  const notes: string[] = [];
  if (wasDeclared && lstatSync(contentEntryPath(dir, removed), { throwIfNoEntry: false })) {
    notes.push(
      `content/${removed} is left as it is: it may hold the agent's work — delete it once nothing in it is needed`,
    );
  }
  return { name: removed, content: resolveContent(dir, declaration), notes };
}

/**
 * `maps` with `addition` among them, checked as a whole before anything is written: its name can name an entry and is
 * not taken (ignoring case), the entry is valid, a repository to clone has nothing at `content/<name>` yet, a
 * directory to bind can be bound, and every other entry still resolves (one that does not refuses the edit, not fails
 * it once made).
 */
function withAddition(agentDir: string, maps: ContentMaps, addition: ContentAddition): { maps: ContentMaps } {
  const { name, entry, binding } = addition;
  if (entry === undefined && binding === undefined) throw new Error(`content "${name}": nothing to add`);
  if (!isContentName(name)) {
    throw new ContentNameError(`"${name}" cannot name content (one path segment of letters, digits, "-" and "_")`);
  }
  const taken = [...Object.keys(maps.content), ...Object.keys(maps.bindings)].find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new ContentNameError(`this agent already has content named "${taken}"`);
  const next: ContentMaps = {
    content: entry !== undefined ? { ...maps.content, [name]: canonicalEntry(entry) } : maps.content,
    bindings: binding !== undefined ? { ...maps.bindings, [name]: canonicalBinding(binding) } : maps.bindings,
  };
  const declaration = declarationOf(agentDir, next);
  if (binding === undefined) {
    if (lstatSync(contentEntryPath(agentDir, name), { throwIfNoEntry: false })) {
      throw new Error(`content/${name} already exists in ${agentDir}: move it away first`);
    }
  } else {
    const bound = declaration.bound.find((b) => b.name === name) as BoundContent;
    const repository = declaration.declared.find((d) => d.name === name);
    checkBinding(agentDir, name, bound.path, repository);
  }
  resolveContent(agentDir, declaration);
  return { maps: next };
}

/** `maps` declared: what every reader of the files would read from them. */
function declarationOf(agentDir: string, maps: ContentMaps): ContentDeclaration {
  const declared = declareContent(maps.content);
  return { declared, bound: declareBindings(maps.bindings, declared, agentDir) };
}

function mapsOf(shared: ContextFile, local: LocalContextFile): ContentMaps {
  return { content: shared.content, bindings: local.content };
}

function without<T>(map: Record<string, T>, name: string): Record<string, T> {
  return Object.fromEntries(Object.entries(map).filter(([key]) => key !== name));
}

/**
 * Where the entry `name` matches ignoring case is written: its name, and which of the two files hold it. One the agent
 * does not have is a {@link ContentNameError}.
 */
function entryNamed(maps: ContentMaps, name: string): { name: string; shared: boolean; local: boolean } {
  const matches = (key: string) => key.toLowerCase() === name.toLowerCase();
  const shared = Object.keys(maps.content).find(matches);
  const local = Object.keys(maps.bindings).find(matches);
  const found = shared ?? local;
  if (found !== undefined) return { name: found, shared: shared !== undefined, local: local !== undefined };
  const names = [...new Set([...Object.keys(maps.content), ...Object.keys(maps.bindings)])];
  throw new ContentNameError(`no content named "${name}" (this agent has: ${names.join(", ") || "none"})`);
}

/**
 * Run `edit` over both context files under ONE lock, `context.json`'s, which env edits take too: whether a name is
 * taken is asked of both files, so two edits that write different files must still queue behind each other. The lock
 * creates neither file; what `edit` returns for a file is written under it, `context.local.json` first.
 */
async function editContext<T>(
  dir: string,
  edit: (shared: ContextFile, local: LocalContextFile) => { result: T; shared?: string; local?: string },
): Promise<T> {
  const sharedPath = join(dir, CONTEXT_FILE);
  const localPath = join(dir, LOCAL_CONTEXT_FILE);
  return withLockedFile(
    sharedPath,
    async (sharedText): Promise<LockResult<T>> => {
      const shared =
        sharedText === undefined ? { content: {}, declared: [] } : parseContextFile(sharedText, sharedPath);
      const localText = textIfExists(localPath);
      const local =
        localText === undefined
          ? { content: {}, bound: [] }
          : parseLocalContextFile(localText, localPath, shared.declared, dir);
      const out = edit(shared, local);
      if (out.local !== undefined) writeFileAtomic(localPath, out.local, fileMode(localPath));
      return { result: out.result, next: out.shared };
    },
    { mode: fileMode(sharedPath), create: false },
  );
}

function textIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * What to say when git would commit `context.local.json`: it names directories of this machine, so committed it would
 * point every other checkout of the agent at paths it does not have. `init` ignores it; an agent made before that may
 * not. Asked only of an agent in a git repository, and never failing an edit that has already been made.
 */
function unignoredLocalFile(dir: string): string[] {
  const git = gitFor("to check that context.local.json stays out of git");
  try {
    if (git.answer(["rev-parse", "--is-inside-work-tree"], dir) !== "true") return [];
    if (git.answer(["check-ignore", "-q", LOCAL_CONTEXT_FILE], dir) !== undefined) return [];
  } catch (error) {
    if (error instanceof GitNotInstalled) return [];
    throw error;
  }
  return [`${LOCAL_CONTEXT_FILE} holds directories of this machine and git does not ignore it: add it to .gitignore`];
}

/**
 * Replace the environment `context.json` declares with what `change` makes of it as it is now, under the lock content
 * edits take, keeping the rest of the file as it is; and return what was written.
 */
export async function writeEnvironment(
  agentDir: string,
  change: (current: DeclaredEnvironment | undefined) => DeclaredEnvironment,
): Promise<DeclaredEnvironment> {
  const path = join(resolveAgentDir(agentDir), CONTEXT_FILE);
  return withLockedFile(
    path,
    async (src) => {
      const file = parseContextFile(src ?? "{}", path);
      const environment = change(file.environment);
      return { result: environment, next: contextFileText({ ...file, environment }) };
    },
    { mode: fileMode(path) },
  );
}

/** The mode a rewrite of `path` keeps: its own, or the definition's default for a new one. */
function fileMode(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat === undefined ? CONTEXT_FILE_MODE : stat.mode & 0o777;
}
