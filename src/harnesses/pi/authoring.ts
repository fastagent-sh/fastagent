/**
 * Creating an agent and editing its content and the contexts it uses, as an API: `fastagent init`, `fastagent content`
 * and `fastagent context` are thin CLI wrappers over these (and `fastagent env` writes its declaration through
 * {@link writeEnvironment}), so the CLI and a client (a desktop app) cannot disagree about the rules. Nothing here
 * prints or exits; every refusal is thrown with the message the CLI shows.
 */
import { existsSync, lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import { GitNotInstalled, gitFor } from "../../git.ts";
import {
  CONTEXTS_DIRNAME,
  CONTEXT_FILE,
  LOCAL_CONTEXT_FILE,
  contentEntryPath,
  contextCopyPath,
  resolveAgentDir,
} from "../../paths.ts";
import { type ScaffoldOptions, initRepository, scaffoldAgent } from "../../scaffold/init.ts";
import {
  type BoundContent,
  type ContentBinding,
  type ContentDeclaration,
  type ContentEntry,
  type DeclaredContent,
  canonicalBinding,
  canonicalEntry,
  declareBindings,
  declareCheckouts,
  declareContent,
  isContentName,
} from "../../content/declare.ts";
import {
  type ContextFile,
  type LocalContextFile,
  contextFileText,
  contextsContent,
  contextsEnvironment,
  loadContent,
  localContextFileText,
  parseContextFile,
  parseLocalContextFile,
  readContextFile,
} from "../../content/file.ts";
import type { DeclaredEnvironment } from "../../environment/declare.ts";
import {
  type ContextEntry,
  type DeclaredContext,
  canonicalContextEntry,
  declareContexts,
} from "../../contexts/declare.ts";
import { type FetchedContext, fetchContexts, fetchedContexts, withContextCopy } from "../../contexts/fetch.ts";
import { type DeclaredPart, joinContent, joinEnvironment } from "../../contexts/join.ts";
import {
  type ResolvedContent,
  checkBinding,
  contentAbsentHere,
  resolveContent,
  staleCheckouts,
} from "../../content/resolve.ts";
import type { ContentAddition } from "../../content/source.ts";
import { type LockResult, withLockedFile } from "../../locked-file.ts";

/** `context.json` is part of the definition, read by whoever reads the agent. */
const CONTEXT_FILE_MODE = 0o644;

/**
 * A refusal about a content entry's NAME: one that cannot name an entry, one the agent already has, one it does not
 * have. The caller can fix it by naming another (the CLI exits 2 and asks for `--name`).
 */
export class ContentNameError extends Error {
  override name = "ContentNameError";
}

/** A refusal about a context's NAME, as {@link ContentNameError} is about a content entry's. */
export class ContextNameError extends Error {
  override name = "ContextNameError";
}

export interface CreateAgentOptions extends ScaffoldOptions {
  /** What the agent works on and knows: repositories into `context.json`, this machine's directories into
   *  `context.local.json`. */
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
 * The three content maps an edit rewrites, as written: `context.json`'s entries, and `context.local.json`'s two,
 * beside the content the agent's contexts declare, which no content edit writes and every one joins.
 */
interface ContentMaps {
  /** `context.json`'s entries: the repositories every instance reaches. */
  shared: Record<string, ContentEntry>;
  /** `context.local.json`'s `checkouts`: this machine's own checkout of a declared entry, by name. */
  checkouts: Record<string, string>;
  /** `context.local.json`'s `content`: directories only this machine has. */
  bindings: Record<string, ContentBinding>;
  contexts: DeclaredPart<DeclaredContent[]>[];
}

/** The text `context.local.json` holds for `maps`. */
function localContextText(maps: ContentMaps): string {
  return localContextFileText({ checkouts: maps.checkouts, content: maps.bindings });
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
  let maps: ContentMaps = { shared: {}, checkouts: {}, bindings: {}, contexts: [] };
  for (const addition of additions) maps = withAddition(agentDir, maps, addition).maps;
  const { created, undo } = await scaffoldAgent(agentDir, { webAccess: options.webAccess });
  const removeAll = async (error: unknown): Promise<never> => {
    await rm(join(agentDir, CONTEXT_FILE), { force: true });
    await rm(join(agentDir, LOCAL_CONTEXT_FILE), { force: true });
    await undo();
    throw error;
  };
  // The content was checked above, so a refusal here is one that check could not foresee (the disk changed in
  // between); the scaffold goes with it, or a retry would find "already an agent" declaring no content.
  try {
    if (Object.keys(maps.shared).length > 0) {
      writeFileAtomic(join(agentDir, CONTEXT_FILE), contextFileText({ content: maps.shared }), CONTEXT_FILE_MODE);
    }
    if (Object.keys(maps.checkouts).length > 0 || Object.keys(maps.bindings).length > 0) {
      writeFileAtomic(join(agentDir, LOCAL_CONTEXT_FILE), localContextText(maps), CONTEXT_FILE_MODE);
    }
  } catch (error) {
    await removeAll(error);
  }
  if (options.install) await options.install(agentDir).catch(removeAll);
  const content = resolveContent(agentDir, declarationOf(agentDir, maps));
  return { dir: agentDir, created, content, repository: await initRepository(agentDir) };
}

/**
 * The agent's content, resolved for this instance (what `fastagent content list` shows), the directories this machine
 * binds that are not here, and the checkout bindings nothing declares: the agent is told of none of them.
 */
export async function listContent(
  agentDir: string,
): Promise<{ content: ResolvedContent[]; absent: BoundContent[]; stale: BoundContent[] }> {
  const dir = resolveAgentDir(agentDir);
  const declaration = loadContent(dir);
  return {
    content: resolveContent(dir, declaration),
    absent: contentAbsentHere(declaration),
    stale: staleCheckouts(declaration),
  };
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
  const declaration = await editContext(dir, (shared, local, contexts) => {
    const { maps } = withAddition(
      dir,
      { shared: shared.content, checkouts: local.checkouts, bindings: local.content, contexts },
      addition,
    );
    return {
      result: declarationOf(dir, maps),
      ...(addition.entry !== undefined ? { shared: contextFileText({ ...shared, content: maps.shared }) } : {}),
      ...(writesLocal(addition) ? { local: localContextText(maps) } : {}),
    };
  });
  const notes = writesLocal(addition) ? unignored(dir, LOCAL_CONTEXT_FILE, "directories of this machine") : [];
  return { name: addition.name, content: resolveContent(dir, declaration), notes };
}

/** Whether adding `addition` writes `context.local.json`: a checkout here, or a directory only this machine has. */
function writesLocal(addition: ContentAddition): boolean {
  return addition.checkout !== undefined || addition.binding !== undefined;
}

/**
 * Remove the agent's content entry named `name` (ignoring case), from `context.json` and from this machine's
 * `context.local.json`. A clone at `content/<name>` is left as it is, and said: it may hold the agent's work, and
 * fastagent never deletes a directory in `content/`. A name the agent does not have is a {@link ContentNameError}.
 */
export async function removeContent(agentDir: string, name: string): Promise<ContentEdit> {
  const dir = resolveAgentDir(agentDir);
  const { removed, wasDeclared, declaration } = await editContext(dir, (shared, local, contexts) => {
    const found = entryNamed(
      { shared: shared.content, checkouts: local.checkouts, bindings: local.content, contexts },
      name,
    );
    const maps = {
      shared: without(shared.content, found.name),
      checkouts: without(local.checkouts, found.name),
      bindings: without(local.content, found.name),
      contexts,
    };
    const declaration = declarationOf(dir, maps);
    // What is left is resolved before it is written, so an entry that cannot be refuses the edit rather than failing
    // it once it is made. The removed one is not asked: removing a broken entry is how it is mended.
    resolveContent(dir, declaration);
    return {
      result: { removed: found.name, wasDeclared: found.shared, declaration },
      ...(found.shared ? { shared: contextFileText({ ...shared, content: maps.shared }) } : {}),
      ...(found.local ? { local: localContextText(maps) } : {}),
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
  const { name, entry, checkout, binding } = addition;
  if (entry === undefined && binding === undefined && checkout === undefined) {
    throw new Error(`content "${name}": nothing to add`);
  }
  if (!isContentName(name)) {
    throw new ContentNameError(`"${name}" cannot name content (one path segment of letters, digits, "-" and "_")`);
  }
  if (checkout !== undefined && entry === undefined) {
    throw new Error(`content "${name}": a checkout is this machine's copy of a repository, which "entry" declares`);
  }
  const taken = [...Object.keys(maps.shared), ...Object.keys(maps.checkouts), ...Object.keys(maps.bindings)].find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new ContentNameError(`this agent already has content named "${taken}"`);
  const fromContext = contextEntry(maps, name);
  if (fromContext !== undefined && entry !== undefined) {
    throw new ContentNameError(
      `the context "${fromContext.context}" declares content named "${fromContext.entry.name}" (${fromContext.source})`,
    );
  }
  const next: ContentMaps = {
    shared: entry !== undefined ? { ...maps.shared, [name]: canonicalEntry(entry) } : maps.shared,
    checkouts: checkout !== undefined ? { ...maps.checkouts, [name]: checkout } : maps.checkouts,
    bindings: binding !== undefined ? { ...maps.bindings, [name]: canonicalBinding(binding) } : maps.bindings,
    contexts: maps.contexts,
  };
  const declaration = declarationOf(agentDir, next);
  if (checkout === undefined && binding === undefined) {
    if (lstatSync(contentEntryPath(agentDir, name), { throwIfNoEntry: false })) {
      throw new Error(`content/${name} already exists in ${agentDir}: move it away first`);
    }
  } else {
    const at = declaration.bound.find((one) => one.name === name) as BoundContent;
    // A checkout is checked against the repository it is declared to be; a directory of this machine against nothing.
    checkBinding(
      agentDir,
      name,
      at.path,
      at.kind === "checkout" ? declaration.declared.find((one) => one.name === name) : undefined,
    );
  }
  resolveContent(agentDir, declaration);
  return { maps: next };
}

/** `maps` declared, the agent's own content joined with its contexts': what every reader of the files would read. */
function declarationOf(agentDir: string, maps: ContentMaps): ContentDeclaration {
  const declared = joinContent([{ source: CONTEXT_FILE, declared: declareContent(maps.shared) }, ...maps.contexts]);
  return {
    declared,
    bound: [...declareCheckouts(maps.checkouts, agentDir), ...declareBindings(maps.bindings, agentDir)],
  };
}

/** The content entry a context declares under `name` (ignoring case), with the context and its file. */
function contextEntry(
  maps: Pick<ContentMaps, "contexts">,
  name: string,
): { context: string; source: string; entry: DeclaredContent } | undefined {
  for (const { context, source, declared } of maps.contexts) {
    const entry = declared.find((one) => one.name.toLowerCase() === name.toLowerCase());
    if (entry !== undefined) return { context: context as string, source, entry };
  }
  return undefined;
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
  const shared = Object.keys(maps.shared).find(matches);
  const local = [...Object.keys(maps.checkouts), ...Object.keys(maps.bindings)].find(matches);
  const found = shared ?? local;
  if (found !== undefined) return { name: found, shared: shared !== undefined, local: local !== undefined };
  const fromContext = contextEntry(maps, name);
  if (fromContext !== undefined) {
    throw new Error(
      `content "${fromContext.entry.name}" is declared by ${fromContext.source}, the context "${fromContext.context}" ` +
        `— it goes with the context (fastagent context remove ${fromContext.context})`,
    );
  }
  const names = [
    ...new Set([...Object.keys(maps.shared), ...Object.keys(maps.checkouts), ...Object.keys(maps.bindings)]),
  ];
  throw new ContentNameError(`no content named "${name}" (this agent has: ${names.join(", ") || "none"})`);
}

/**
 * Run `edit` over both context files under ONE lock, `context.json`'s, which env edits take too: whether a name is
 * taken is asked of both files, so two edits that write different files must still queue behind each other. The lock
 * creates neither file; what `edit` returns for a file is written under it, `context.local.json` first.
 */
async function editContext<T>(
  dir: string,
  edit: (
    shared: ContextFile,
    local: LocalContextFile,
    contexts: DeclaredPart<DeclaredContent[]>[],
  ) => { result: T; shared?: string; local?: string },
): Promise<T> {
  const sharedPath = join(dir, CONTEXT_FILE);
  const localPath = join(dir, LOCAL_CONTEXT_FILE);
  return withLockedFile(
    sharedPath,
    async (sharedText): Promise<LockResult<T>> => {
      const shared = parseContextFile(sharedText ?? "{}", sharedPath);
      const contexts = contextsContent(dir, shared.declaredContexts);
      const localText = textIfExists(localPath);
      const local =
        localText === undefined
          ? { checkouts: {}, content: {}, bound: [] }
          : parseLocalContextFile(localText, localPath, dir);
      const out = edit(shared, local, contexts);
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
 * What to say when git would commit `path`, which holds `what` and belongs to this machine: `context.local.json` would
 * point every other checkout of the agent at paths it does not have, and `.contexts/` would commit copies a deploy
 * fetches afresh. `init` ignores both; an agent made before that may not. Asked only of an agent in a git repository,
 * and never failing an edit that has already been made.
 */
function unignored(dir: string, path: string, what: string): string[] {
  const git = gitFor(`to check that ${path} stays out of git`);
  try {
    if (git.answer(["rev-parse", "--is-inside-work-tree"], dir) !== "true") return [];
    if (git.answer(["check-ignore", "-q", path], dir) !== undefined) return [];
  } catch (error) {
    if (error instanceof GitNotInstalled) return [];
    throw error;
  }
  return [`${path} holds ${what} and git does not ignore it: add it to .gitignore`];
}

/** A context to add: its name and the entry `context.json` gets. */
export interface ContextAddition {
  name: string;
  entry: ContextEntry;
}

/** What a context edit leaves: the context it added or removed, the agent's contexts after it, and what to tell. */
export interface ContextEdit {
  name: string;
  contexts: FetchedContext[];
  notes: string[];
}

export interface AddContextOptions {
  /**
   * Install the environment the agent has with the context, before it is declared, so a declared context is one whose
   * packages install: `added` names the packages the context brings that the agent did not have. The CLI installs
   * them with the agent's own mise, as `fastagent env add` does. A rejection leaves the context undeclared.
   */
  install?: (environment: DeclaredEnvironment, added: string[]) => Promise<void>;
}

/**
 * Add a context to the agent in `agentDir`: fetch it, refusing when it cannot be fetched or holds no context; check that
 * its declarations join the agent's (a content name or a package version two declare refuses, naming both); run
 * `install`; and declare it in `context.json`. A failure after the fetch leaves no copy and no declaration. A name that
 * cannot be one, or that the agent already uses (ignoring case), is a {@link ContextNameError}.
 */
export async function addContext(
  agentDir: string,
  addition: ContextAddition,
  options: AddContextOptions = {},
): Promise<ContextEdit> {
  const dir = resolveAgentDir(agentDir);
  const { name } = addition;
  const entry = canonicalContextEntry(addition.entry);
  const path = join(dir, CONTEXT_FILE);
  await withLockedFile(
    path,
    async (text) => {
      const file = parseContextFile(text ?? "{}", path);
      contextNameFree(file, name);
      const [context] = declareContexts({ [name]: entry }) as [DeclaredContext];
      const existed = existsSync(contextCopyPath(dir, name));
      await fetchContexts(dir, [context], "fail");
      try {
        const contexts = [...file.declaredContexts, context];
        const parts = contextsContent(dir, contexts);
        const declared = joinContent([{ source: CONTEXT_FILE, declared: file.declared }, ...parts]);
        const localPath = join(dir, LOCAL_CONTEXT_FILE);
        const local = parseLocalContextFile(textIfExists(localPath) ?? "{}", localPath, dir);
        resolveContent(dir, { declared, bound: local.bound });
        const own = { source: CONTEXT_FILE, declared: file.environment };
        const had = joinEnvironment([own, ...contextsEnvironment(dir, file.declaredContexts)]);
        const environment = joinEnvironment([own, ...contextsEnvironment(dir, contexts)]);
        if (environment !== undefined && options.install) {
          const added = Object.keys(environment.packages).filter((pkg) => !Object.hasOwn(had?.packages ?? {}, pkg));
          await options.install(environment, added);
        }
        return {
          result: undefined,
          next: contextFileText({ ...file, contexts: { ...file.contexts, [name]: entry } }),
        };
      } catch (error) {
        if (!existed) rmSync(contextCopyPath(dir, name), { recursive: true, force: true });
        throw error;
      }
    },
    { mode: fileMode(path), create: false },
  );
  return {
    name,
    contexts: fetchedContexts(dir, readContextFile(dir).declaredContexts),
    notes: unignored(dir, CONTEXTS_DIRNAME, "the contexts' copies, which each deploy fetches afresh"),
  };
}

/**
 * Remove the cached copy and declaration under the agent's lock; content clones, installed packages and this machine's
 * bindings are kept. A checkout binding of content the context declared is left in `context.local.json`, where it is
 * reported as a checkout nothing declares: nothing here can tell what a context declared once its copy is gone.
 */
export async function removeContext(agentDir: string, name: string): Promise<ContextEdit> {
  const dir = resolveAgentDir(agentDir);
  const path = join(dir, CONTEXT_FILE);
  const removed = await withLockedFile(
    path,
    async (text) => {
      const file = parseContextFile(text ?? "{}", path);
      const found = file.declaredContexts.find((context) => context.name.toLowerCase() === name.toLowerCase());
      if (found === undefined) {
        const names = file.declaredContexts.map((context) => context.name);
        throw new ContextNameError(`no context named "${name}" (this agent uses: ${names.join(", ") || "none"})`);
      }
      const contexts = without(file.contexts, found.name);
      await withContextCopy(dir, found.name, async () => {
        rmSync(contextCopyPath(dir, found.name), { recursive: true, force: true });
      });
      return { result: found.name, next: contextFileText({ ...file, contexts }) };
    },
    { mode: fileMode(path), create: false },
  );
  return {
    name: removed,
    contexts: fetchedContexts(dir, readContextFile(dir).declaredContexts),
    notes: [
      "content clones and installed packages are left as they are",
      `checkout bindings in ${LOCAL_CONTEXT_FILE} are left as they are, and reported as binding content nothing ` +
        "declares (fastagent content remove <name>)",
    ],
  };
}

/** Refuse `name` as a new context's when it cannot name one or the agent already uses it (ignoring case). */
function contextNameFree(file: ContextFile, name: string): void {
  if (!isContentName(name)) {
    throw new ContextNameError(`"${name}" cannot name a context (one path segment of letters, digits, "-" and "_")`);
  }
  const taken = file.declaredContexts.find((context) => context.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new ContextNameError(`this agent already uses a context named "${taken.name}"`);
}

/**
 * Replace the environment `context.json` declares with what `change` makes of it as it is now, under the lock content
 * edits take, keeping the rest of the file as it is; and return what was written.
 */
export async function writeEnvironment(
  agentDir: string,
  change: (current: DeclaredEnvironment | undefined) => DeclaredEnvironment,
): Promise<DeclaredEnvironment> {
  const dir = resolveAgentDir(agentDir);
  const path = join(dir, CONTEXT_FILE);
  return withLockedFile(
    path,
    async (src) => {
      const file = parseContextFile(src ?? "{}", path);
      const environment = change(file.environment);
      joinEnvironment([
        { source: CONTEXT_FILE, declared: environment },
        ...contextsEnvironment(dir, file.declaredContexts),
      ]);
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
