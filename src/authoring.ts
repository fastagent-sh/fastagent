/**
 * Creating an agent and editing its content: `fastagent init` and `fastagent content` are thin wrappers over these (and
 * `fastagent env` writes its declaration through {@link writeEnvironment}), so the rules live here, not in a command.
 * Nothing here prints or exits; every refusal is thrown with the message the CLI shows. The package exports
 * {@link createAgent} and the content edits ({@link addContent}, {@link removeContent}, {@link listContent}), which
 * give an agent its own entries, without an alias prefix, and the instance's MCP server edits ({@link addMcpServer},
 * {@link removeMcpServer}), which take the same lock; the environment's edit is not exported.
 */
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { CONTEXT_FILE, INSTANCE_CONFIG_FILE, contentEntryPath, resolveAgentDir } from "./paths.ts";
import { initRepository, scaffoldAgent } from "./scaffold/init.ts";
import {
  type ContentEntry,
  type DeclaredContent,
  canonicalEntry,
  declareContent,
  isContentName,
  joinContent,
} from "./content/declare.ts";
import { contextFileText, loadContent, parseContextFile, readContextFile } from "./content/file.ts";
import type { DeclaredEnvironment } from "./environment/declare.ts";
import { type ResolvedContent, checkDirectory, resolveContent } from "./content/resolve.ts";
import type { ContentAddition } from "./content/source.ts";
import type { AgentDefinition } from "./harnesses/pi-durable/definition.ts";
import { type LockResult, withLockedFile } from "./locked-file.ts";
import { McpError } from "./mcp-api.ts";
import {
  type McpInstance,
  type McpServerDeclaration,
  declareMcp,
  literalCredentialAdvice,
  literalCredentials,
} from "./mcp/config.ts";

/** `context.json` and `fastagent.json` are part of an agent's text: read by whoever reads the agent. */
const CONTEXT_FILE_MODE = 0o644;

/**
 * A refusal about a content entry's NAME: one that cannot name an entry, one the agent already has, one it does not
 * have. The caller can fix it by naming another (the CLI exits 2 and asks for `--name`).
 */
export class ContentNameError extends Error {
  override name = "ContentNameError";
}

export interface InitAgentOptions {
  /** What the agent works on: repositories for its program into `context.json`, the rest into `fastagent.json`. */
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

/**
 * Where an agent's content is declared and kept: which instance configuration is edited, and where clones go. For a
 * built definition, which has no instance of its own, `config` is required and `workdir` defaults to the directory
 * of `config`, the instance root.
 */
export interface ContentInstance {
  /** The instance configuration to edit, absolute. Default: `fastagent.json` in the agent directory. */
  config?: string;
  /** The instance's working directory, where a clone is made. Default: the agent directory. */
  workdir?: string;
}

/** The two content maps an edit rewrites, as written: the program's `context.json` and the instance's configuration. */
interface ContentMaps {
  program: Record<string, ContentEntry>;
  instance: Record<string, ContentEntry>;
}

/** Where an agent's content is, settled: every path absolute. */
interface Places {
  /** The program's directory: where its `context.json` is. */
  dir: string;
  workdir: string;
  config: string;
  /** The program is a built definition, which is read and never written. */
  built: boolean;
}

const placesOf = (dir: string, instance: ContentInstance = {}): Places => {
  const config = instance.config ?? join(dir, INSTANCE_CONFIG_FILE);
  for (const [name, path] of [
    ["config", instance.config],
    ["workdir", instance.workdir],
  ] as const) {
    if (path !== undefined && !isAbsolute(path)) throw new Error(`${name} must be an absolute path, and is "${path}"`);
  }
  return { dir, workdir: instance.workdir ?? dir, config, built: false };
};

/** The places of an agent named by its source directory, or by the built definition a host opens. */
function placesFor(agent: string | AgentDefinition, instance: ContentInstance = {}): Places {
  if (typeof agent === "string") return placesOf(resolveAgentDir(agent), instance);
  if (instance.config === undefined) {
    throw new Error(
      `${agent.name} is a built definition with no instance configuration of its own: pass instance.config`,
    );
  }
  const places = placesOf(agent.dir, { ...instance, workdir: instance.workdir ?? dirname(instance.config) });
  return { ...places, built: true };
}

/**
 * Create an agent in `dir` as `fastagent init` does, which must be new or empty: the whole scaffold, and a git
 * repository whose first commit is what was written, since the agent changes itself and version control is how its
 * author goes back to a version that worked. It installs no dependencies; the agent opens without them.
 *
 * `content` gives it any number of entries, each a directory of this machine or a GitHub repository. They are all
 * checked before anything is written, and one that is refused leaves no directory. Two entries may be the same
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
  const places = placesOf(agentDir);
  let maps: ContentMaps = { program: {}, instance: {} };
  for (const addition of options.content ?? []) maps = withAddition(places, maps, addition).maps;
  const { created, undo } = await scaffoldAgent(agentDir);
  const removeAll = async (error: unknown): Promise<never> => {
    await rm(join(agentDir, CONTEXT_FILE), { force: true });
    await rm(join(agentDir, INSTANCE_CONFIG_FILE), { force: true });
    await undo();
    throw error;
  };
  // The content was checked above, so a refusal here is one that check could not foresee (the disk changed in
  // between); the scaffold goes with it, or a retry would find "already an agent" declaring no content.
  try {
    if (Object.keys(maps.program).length > 0) {
      writeFileAtomic(join(agentDir, CONTEXT_FILE), contextFileText({ content: maps.program }), CONTEXT_FILE_MODE);
    }
    if (Object.keys(maps.instance).length > 0) {
      writeFileAtomic(places.config, instanceFileText({}, maps.instance), CONTEXT_FILE_MODE);
    }
  } catch (error) {
    await removeAll(error);
  }
  if (options.install) await options.install(agentDir).catch(removeAll);
  const content = resolveContent(declarationOf(places, maps), places);
  return { dir: agentDir, created, content, repository: await initRepository(agentDir) };
}

/**
 * The on-disk declaration resolved for this machine, not an open agent's startup snapshot. An entry that cannot be
 * resolved (a directory that is gone) refuses, naming it.
 */
export async function listContent(
  agent: string | AgentDefinition,
  instance?: ContentInstance,
): Promise<{ content: ResolvedContent[] }> {
  const places = placesFor(agent, instance);
  return { content: resolveContent(loadContent(places.dir, instanceSourceOf(places)), places) };
}

/**
 * The edited declaration resolved for this machine; an already-open agent keeps its startup snapshot until reopened.
 */
export interface ContentEdit {
  name: string;
  content: ResolvedContent[];
  notes: string[];
}

/**
 * Add a content entry to `agent`, a source directory or a built definition: to the instance configuration
 * (`fastagent.json`, or the file `instance.config` names), or with `program` to the program's `context.json`, which a
 * built definition does not allow. A name that cannot be one, or that the agent already has in either (ignoring
 * case), is a {@link ContentNameError}.
 */
export async function addContent(
  agent: string | AgentDefinition,
  addition: ContentAddition,
  instance?: ContentInstance,
): Promise<ContentEdit> {
  const places = placesFor(agent, instance);
  const declaration = await editContent(places, (maps) => {
    const next = withAddition(places, maps, addition).maps;
    return { result: declarationOf(places, next), next };
  });
  return { name: addition.name, content: resolveContent(declaration, places), notes: [] };
}

/**
 * Remove the agent's content entry named `name` (ignoring case), from whichever of `context.json` and the instance
 * configuration holds it. A clone at `content/<name>` is left as it is, and said: it may hold the agent's work, and
 * fastagent never deletes a directory in `content/`. A name the agent does not have is a {@link ContentNameError}. An
 * entry a built definition's `context.json` declares is refused: the program is read, never edited.
 */
export async function removeContent(
  agent: string | AgentDefinition,
  name: string,
  instance?: ContentInstance,
): Promise<ContentEdit> {
  const places = placesFor(agent, instance);
  const { removed, wasClone, declaration } = await editContent(places, (maps) => {
    const found = entryNamed(maps, name);
    const next = {
      program: without(maps.program, found),
      instance: without(maps.instance, found),
    };
    const declaration = declarationOf(places, next);
    // What is left is resolved before it is written, so an entry that cannot refuses the edit rather than failing it
    // once it is made. The removed one is not asked: removing a broken entry is how it is mended.
    resolveContent(declaration, places);
    const was = declarationOf(places, maps).find((entry) => entry.name === found);
    return { result: { removed: found, wasClone: was?.kind === "github", declaration }, next };
  });
  const notes: string[] = [];
  if (wasClone && lstatSync(contentEntryPath(places.workdir, removed), { throwIfNoEntry: false })) {
    notes.push(
      `content/${removed} is left as it is: it may hold the agent's work — delete it once nothing in it is needed`,
    );
  }
  return { name: removed, content: resolveContent(declaration, places), notes };
}

/** One server as an instance's `mcpServers` holds it: a stdio server by `command`, or an HTTP one by `type` and `url`. */
export type McpServerInput = McpServerDeclaration;

export interface McpEdit {
  name: string;
  /** What the host should say or refuse: each literal credential the added entry carries. Empty for a removal. */
  notes: string[];
}

/**
 * Add the MCP server `name` to the instance configuration of `agent`, a source directory or a built definition (which
 * needs `instance.config`), keeping every other key of the file. The result is checked as an open checks it, the
 * program's servers included, so a refusal is the open's own message and nothing is written: unknown fields, an address
 * that is not allowed, a name the program declares, a name this instance already has. Under the lock
 * {@link addContent} takes. Grants and bindings are the host's and are not touched.
 */
export async function addMcpServer(
  agent: string | AgentDefinition,
  name: string,
  server: McpServerInput,
  instance?: ContentInstance,
): Promise<McpEdit> {
  const places = placesFor(agent, instance);
  const literals = await editInstanceFile(places, (file) => {
    const servers = mcpServersOf(file, places);
    if (Object.hasOwn(servers, name)) {
      throw new McpError("configuration", `already declared in ${places.config}`, name);
    }
    const next = { ...file, mcpServers: { ...servers, [name]: server } };
    const declared = declareMcp(places.dir, instanceValues(places, next));
    return { result: literalCredentials(declared).filter((literal) => literal.server === name), next };
  });
  return {
    name,
    notes: literals.map(
      (literal) =>
        `${literal.file} mcpServers.${name}.${literal.field}.${literal.key} is a literal value: ${literalCredentialAdvice(literal)}`,
    ),
  };
}

/**
 * Remove the MCP server `name` from the instance configuration of `agent`, keeping every other key of the file. A name
 * the instance does not have is refused, and so is one the program declares: the program is read, never edited. What
 * is left is checked before it is written, so removing a broken entry is how it is mended. Grants and bindings are the
 * host's and are not touched.
 */
export async function removeMcpServer(
  agent: string | AgentDefinition,
  name: string,
  instance?: ContentInstance,
): Promise<McpEdit> {
  const places = placesFor(agent, instance);
  await editInstanceFile(places, (file) => {
    const servers = mcpServersOf(file, places);
    if (!Object.hasOwn(servers, name)) {
      const programs = declareMcp(places.dir).map((declared) => declared.name);
      throw new McpError(
        "configuration",
        programs.includes(name)
          ? `declared by the program (${CONTEXT_FILE}), which is read and never edited`
          : `no MCP server named "${name}" in ${places.config}`,
        name,
      );
    }
    const { [name]: _removed, ...rest } = servers;
    const { mcpServers: _replaced, ...others } = file;
    const next = Object.keys(rest).length > 0 ? { ...others, mcpServers: rest } : others;
    declareMcp(places.dir, instanceValues(places, next));
    return { result: undefined, next };
  });
  return { name, notes: [] };
}

function mcpServersOf(file: Record<string, unknown>, places: Places): Record<string, unknown> {
  const servers = file.mcpServers;
  if (servers === undefined) return {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new McpError("configuration", `${places.config}: "mcpServers" must be an object`);
  }
  return servers as Record<string, unknown>;
}

/**
 * Rewrite the instance configuration with what `edit` makes of the file as it is now, every other key kept, under the
 * lock content edits take, since they write the same file. Nothing is written when `edit` throws.
 */
async function editInstanceFile<T>(
  places: Places,
  edit: (file: Record<string, unknown>) => { result: T; next: Record<string, unknown> },
): Promise<T> {
  const lockPath = lockPathOf(places);
  return withLockedFile(
    lockPath,
    async (): Promise<LockResult<T>> => {
      const text = textIfExists(places.config);
      const out = edit(text === undefined ? {} : parseInstanceFile(text, places.config));
      writeFileAtomic(places.config, `${JSON.stringify(out.next, null, 2)}\n`, fileMode(places.config));
      return { result: out.result };
    },
    { mode: fileMode(lockPath), create: false },
  );
}

/**
 * `maps` with `addition` among them, checked as a whole before anything is written: its name can name an entry and is
 * not taken (ignoring case), the entry is valid, a repository to clone has nothing at `content/<name>` yet, a
 * directory can be the content, and every other entry still resolves (one that does not refuses the edit, not fails
 * it once made).
 */
function withAddition(places: Places, maps: ContentMaps, addition: ContentAddition): { maps: ContentMaps } {
  const { name, entry, program } = addition;
  if (!isContentName(name)) {
    throw new ContentNameError(`"${name}" cannot name content (one path segment of letters, digits, "-" and "_")`);
  }
  const taken = [...Object.keys(maps.program), ...Object.keys(maps.instance)].find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new ContentNameError(`this agent already has content named "${taken}"`);
  if (program === true && places.built) {
    throw new Error(`content "${name}": ${CONTEXT_FILE} belongs to a built definition, which is read and never edited`);
  }
  if (program === true && !("github" in entry)) {
    throw new Error(
      `content "${name}": ${CONTEXT_FILE} is shared, so it declares only repositories every instance reaches`,
    );
  }
  const written = { ...(program === true ? maps.program : maps.instance), [name]: canonicalEntry(entry) };
  const next: ContentMaps = program === true ? { ...maps, program: written } : { ...maps, instance: written };
  const declaration = declarationOf(places, next);
  const declared = declaration.find((d) => d.name === name) as DeclaredContent;
  if (declared.kind === "github") {
    if (lstatSync(contentEntryPath(places.workdir, name), { throwIfNoEntry: false })) {
      throw new Error(`content/${name} already exists in ${places.workdir}: move it away first`);
    }
  } else {
    checkDirectory(name, declared.path);
  }
  resolveContent(declaration, places);
  return { maps: next };
}

/** `maps` declared: what every reader of the files would read from them. */
function declarationOf(places: Places, maps: ContentMaps): DeclaredContent[] {
  return joinContent(
    declareContent(maps.program, { origin: "program", file: CONTEXT_FILE }),
    declareContent(maps.instance, { origin: "instance", file: places.config, base: dirname(places.config) }),
  );
}

function without<T>(map: Record<string, T>, name: string): Record<string, T> {
  return Object.fromEntries(Object.entries(map).filter(([key]) => key !== name));
}

/** Where the entry `name` matches ignoring case is written: its name. One the agent does not have is a {@link ContentNameError}. */
function entryNamed(maps: ContentMaps, name: string): string {
  const names = [...Object.keys(maps.program), ...Object.keys(maps.instance)];
  const found = names.find((key) => key.toLowerCase() === name.toLowerCase());
  if (found !== undefined) return found;
  throw new ContentNameError(
    `no content named "${name}" (this agent has: ${[...new Set(names)].join(", ") || "none"})`,
  );
}

/** The instance configuration's content, as `loadContent` reads it: from the file, or none when there is none. */
function instanceSourceOf(places: Places) {
  const text = textIfExists(places.config);
  return text === undefined ? undefined : instanceValues(places, parseInstanceFile(text, places.config));
}

/** The instance configuration `values` as the readers of its declarations take it. */
const instanceValues = (places: Places, values: Record<string, unknown>): McpInstance => ({
  values,
  label: places.config,
  directory: dirname(places.config),
});

/** `text`, the contents of the instance configuration at `path`, as the object it is. */
function parseInstanceFile(text: string, path: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must hold a JSON object`);
  return raw as Record<string, unknown>;
}

/** The instance configuration as written: `file` as it is, with `content` replaced (left out when empty). */
function instanceFileText(file: Record<string, unknown>, content: Record<string, ContentEntry>): string {
  const { content: _replaced, ...rest } = file;
  return `${JSON.stringify(Object.keys(content).length > 0 ? { ...rest, content } : rest, null, 2)}\n`;
}

/**
 * Run `edit` over both files that hold content under ONE lock, `context.json`'s, which env edits take too: whether a
 * name is taken is asked of both, so two edits that write different files must still queue behind each other. The lock
 * creates neither file; what `edit` returns is written under it, the instance configuration first. A file that holds
 * the same content as before is not rewritten. A built definition's `context.json` is only read, in a place that may
 * not be writable, so the lock is the instance configuration's and an edit that would change the program's entries is
 * refused.
 */
async function editContent<T>(
  places: Places,
  edit: (maps: ContentMaps) => { result: T; next: ContentMaps },
): Promise<T> {
  const programPath = join(places.dir, CONTEXT_FILE);
  const lockPath = lockPathOf(places);
  return withLockedFile(
    lockPath,
    async (lockedText): Promise<LockResult<T>> => {
      const program = places.built
        ? readContextFile(places.dir)
        : lockedText === undefined
          ? { content: {}, declared: [] }
          : parseContextFile(lockedText, programPath);
      const instanceText = textIfExists(places.config);
      const instance = instanceText === undefined ? {} : parseInstanceFile(instanceText, places.config);
      const maps: ContentMaps = {
        program: program.content,
        instance: (instance.content ?? {}) as Record<string, ContentEntry>,
      };
      const out = edit(maps);
      const programChanged = !sameEntries(out.next.program, maps.program);
      if (places.built && programChanged) {
        throw new Error(`${programPath} belongs to a built definition, which is read and never edited`);
      }
      if (!sameEntries(out.next.instance, maps.instance)) {
        writeFileAtomic(places.config, instanceFileText(instance, out.next.instance), fileMode(places.config));
      }
      return {
        result: out.result,
        ...(programChanged ? { next: contextFileText({ ...program, content: out.next.program }) } : {}),
      };
    },
    { mode: fileMode(lockPath), create: false },
  );
}

/** The file every edit of an agent's declarations locks: `context.json`, or for a built definition, which only reads it, the instance configuration. */
const lockPathOf = (places: Places): string => (places.built ? places.config : join(places.dir, CONTEXT_FILE));

const sameEntries = (a: Record<string, ContentEntry>, b: Record<string, ContentEntry>) =>
  JSON.stringify(a) === JSON.stringify(b);

function textIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Set what the instance configuration says of the channel `channel` (`channels.<channel>` in `fastagent.json` in
 * `agentDir`, or the file `instance.config` names): `entry` over what it holds, the rest of the file kept as it is. Under
 * the lock content edits take, since they write the same file.
 */
export async function setChannelConfig(
  agentDir: string,
  channel: string,
  entry: { ingress?: "webhook" | "connection"; app?: { id: string; team?: string; url?: string } },
  instance?: Pick<ContentInstance, "config">,
): Promise<void> {
  const places = placesOf(resolveAgentDir(agentDir), instance);
  const programPath = join(places.dir, CONTEXT_FILE);
  await withLockedFile(
    programPath,
    async (): Promise<LockResult<undefined>> => {
      const text = textIfExists(places.config);
      const file = text === undefined ? {} : parseInstanceFile(text, places.config);
      const channels = (file.channels ?? {}) as Record<string, Record<string, unknown>>;
      const next = { ...file, channels: { ...channels, [channel]: { ...channels[channel], ...entry } } };
      writeFileAtomic(places.config, `${JSON.stringify(next, null, 2)}\n`, fileMode(places.config));
      return { result: undefined };
    },
    { mode: fileMode(programPath), create: false },
  );
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
