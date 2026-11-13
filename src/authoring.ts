/**
 * Creating an agent and editing its instance declarations (`fastagent.json` or `instance.config`): `fastagent init` and
 * `fastagent content` wrap these, and the package exports {@link createAgent}, {@link addContent}, {@link removeContent},
 * {@link listContent}, {@link addMcpServer}, and {@link removeMcpServer}. Program-level declarations in
 * `fastagent.config.ts` are read-only here.
 */
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { AGENT_CONFIG_FILE, INSTANCE_CONFIG_FILE, contentEntryPath, resolveAgentDir } from "./paths.ts";
import { loadRawProgramConfig } from "./program-config.ts";
import { initRepository, scaffoldAgent } from "./scaffold/init.ts";
import {
  type ContentEntry,
  type DeclaredContent,
  canonicalEntry,
  declareContent,
  isContentName,
  joinContent,
} from "./content/declare.ts";
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

/** `fastagent.json` is part of an agent's text: readable by whoever reads the agent. */
const INSTANCE_FILE_MODE = 0o644;

/**
 * A refusal about a content entry's NAME: one that cannot name an entry, one the agent already has, one it does not
 * have. The caller can fix it by naming another (the CLI exits 2 and asks for `--name`).
 */
export class ContentNameError extends Error {
  override name = "ContentNameError";
}

export interface InitAgentOptions {
  /** What the agent works on: repositories for `fastagent.config.ts` or local directories for `fastagent.json`. */
  content?: ContentAddition[];
  /** Optional dependency install step run after scaffolding and before the initial git commit. */
  install?: (dir: string) => Promise<void>;
}

export interface CreatedAgent {
  /** The agent directory, absolute. */
  dir: string;
  /** The files written, relative to `dir`. */
  created: string[];
  /** What became of the agent's git repository. */
  repository: string;
}

/**
 * Where an agent's instance content/MCP declarations live. For a built definition, `config` is required and `workdir`
 * defaults to the directory of `config`.
 */
export interface ContentInstance {
  /** The instance configuration to edit, absolute. Default: `fastagent.json` in the agent directory. */
  config?: string;
  /** The instance's working directory, where clones land. Default: the agent directory. */
  workdir?: string;
}

interface Places {
  dir: string;
  workdir: string;
  config: string;
  programContent: Record<string, ContentEntry>;
  programMcp: unknown;
  programFile: string;
}

async function placesFor(agent: string | AgentDefinition, instance: ContentInstance = {}): Promise<Places> {
  const isBuilt = typeof agent !== "string";
  if (isBuilt && instance.config === undefined) {
    throw new Error(
      `${agent.name} is a built definition with no instance configuration of its own: pass instance.config`,
    );
  }
  const dir = isBuilt ? agent.dir : resolveAgentDir(agent);
  const config = instance.config ?? join(dir, INSTANCE_CONFIG_FILE);
  for (const [name, path] of [
    ["config", instance.config],
    ["workdir", instance.workdir],
  ] as const) {
    if (path !== undefined && !isAbsolute(path)) throw new Error(`${name} must be an absolute path, and is "${path}"`);
  }
  const workdir = instance.workdir ?? (isBuilt && instance.config ? dirname(instance.config) : dir);
  const program = isBuilt
    ? { value: agent.config as Record<string, unknown>, file: AGENT_CONFIG_FILE }
    : await loadRawProgramConfig(dir);
  return {
    dir,
    workdir,
    config,
    programContent: (program.value?.content ?? {}) as Record<string, ContentEntry>,
    programMcp: program.value?.mcpServers,
    programFile: program.file,
  };
}

/**
 * Create an agent in `dir` (must be new or empty) and initialize git.
 */
export async function createAgent(
  dir: string,
  options: { content?: ContentAddition[] } = {},
): Promise<CreatedAgent & { content: ResolvedContent[] }> {
  return initAgent(dir, options.content === undefined ? {} : { content: options.content });
}

/**
 * {@link createAgent} with what `fastagent init` adds: optional `npm install`.
 */
export async function initAgent(
  dir: string,
  options: InitAgentOptions = {},
): Promise<CreatedAgent & { content: ResolvedContent[] }> {
  const agentDir = resolve(dir);
  const programEntries: Record<string, ContentEntry> = {};
  const instanceEntries: Record<string, ContentEntry> = {};
  for (const addition of options.content ?? []) {
    const target = "github" in addition.entry ? programEntries : instanceEntries;
    const taken = [...Object.keys(programEntries), ...Object.keys(instanceEntries)].find(
      (k) => k.toLowerCase() === addition.name.toLowerCase(),
    );
    if (!isContentName(addition.name)) {
      throw new ContentNameError(
        `"${addition.name}" cannot name content (one path segment of letters, digits, "-" and "_")`,
      );
    }
    if (taken) throw new ContentNameError(`this agent already has content named "${taken}"`);
    target[addition.name] = canonicalEntry(addition.entry);
  }
  const configPath = join(agentDir, INSTANCE_CONFIG_FILE);
  const previewPlaces = { dir: agentDir, workdir: agentDir, config: configPath };
  const declared = joinContent(
    declareContent(programEntries, { origin: "program", file: AGENT_CONFIG_FILE }),
    declareContent(instanceEntries, { origin: "instance", file: configPath, base: agentDir }),
  );
  for (const entry of declared) {
    if (entry.kind === "local") checkDirectory(entry.name, entry.path);
  }
  resolveContent(declared, previewPlaces);

  const { created, undo } = await scaffoldAgent(agentDir);
  const removeAll = async (error: unknown): Promise<never> => {
    await rm(configPath, { force: true });
    await undo();
    throw error;
  };
  try {
    if (Object.keys(programEntries).length > 0) {
      const cfgPath = join(agentDir, AGENT_CONFIG_FILE);
      const existing = readFileSync(cfgPath, "utf8");
      const rendered = JSON.stringify(programEntries, null, 2)
        .split("\n")
        .map((line, i) => (i === 0 ? line : `  ${line}`))
        .join("\n");
      writeFileAtomic(
        cfgPath,
        existing.replace("} satisfies AgentConfig;", `  content: ${rendered},\n} satisfies AgentConfig;`),
        INSTANCE_FILE_MODE,
      );
    }
    if (Object.keys(instanceEntries).length > 0) {
      writeFileAtomic(configPath, instanceFileText({}, instanceEntries), INSTANCE_FILE_MODE);
    }
  } catch (error) {
    await removeAll(error);
  }
  if (options.install) await options.install(agentDir).catch(removeAll);
  const content = resolveContent(declared, previewPlaces);
  return { dir: agentDir, created, content, repository: await initRepository(agentDir) };
}

/**
 * The on-disk declaration resolved for this machine, not an open agent's startup snapshot.
 */
export async function listContent(
  agent: string | AgentDefinition,
  instance?: ContentInstance,
): Promise<{ content: ResolvedContent[] }> {
  const places = await placesFor(agent, instance);
  return { content: resolveContent(declarationOf(places, readInstanceContent(places)), places) };
}

export interface ContentEdit {
  name: string;
  content: ResolvedContent[];
  notes: string[];
}

/**
 * Add a content entry to the instance configuration (`fastagent.json` or `instance.config`).
 */
export async function addContent(
  agent: string | AgentDefinition,
  addition: ContentAddition,
  instance?: ContentInstance,
): Promise<ContentEdit> {
  const places = await placesFor(agent, instance);
  const declaration = await editInstanceFile(places, (file) => {
    const current = contentOf(file, places);
    const { name, entry } = addition;
    if (!isContentName(name)) {
      throw new ContentNameError(`"${name}" cannot name content (one path segment of letters, digits, "-" and "_")`);
    }
    const taken = [...Object.keys(places.programContent), ...Object.keys(current)].find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    if (taken) throw new ContentNameError(`this agent already has content named "${taken}"`);
    const nextContent = { ...current, [name]: canonicalEntry(entry) };
    const nextDecl = declarationOf(places, nextContent);
    const added = nextDecl.find((d) => d.name === name) as DeclaredContent;
    if (added.kind === "github") {
      if (lstatSync(contentEntryPath(places.workdir, name), { throwIfNoEntry: false })) {
        throw new Error(`content/${name} already exists in ${places.workdir}: move it away first`);
      }
    } else {
      checkDirectory(name, added.path);
    }
    resolveContent(nextDecl, places);
    return { result: nextDecl, next: instanceFileWith(file, "content", nextContent) };
  });
  return { name: addition.name, content: resolveContent(declaration, places), notes: [] };
}

/**
 * Remove the content entry named `name` (ignoring case) from the instance configuration.
 * Entries declared in `fastagent.config.ts` are read-only and refused.
 */
export async function removeContent(
  agent: string | AgentDefinition,
  name: string,
  instance?: ContentInstance,
): Promise<ContentEdit> {
  const places = await placesFor(agent, instance);
  const { removed, wasClone, declaration } = await editInstanceFile(places, (file) => {
    const current = contentOf(file, places);
    const instanceMatch = Object.keys(current).find((key) => key.toLowerCase() === name.toLowerCase());
    if (instanceMatch === undefined) {
      const programMatch = Object.keys(places.programContent).find((key) => key.toLowerCase() === name.toLowerCase());
      if (programMatch !== undefined) {
        throw new Error(
          `content "${programMatch}" is declared by the program (${places.programFile}), which is read and never edited`,
        );
      }
      const names = [...Object.keys(places.programContent), ...Object.keys(current)];
      throw new ContentNameError(
        `no content named "${name}" (this agent has: ${[...new Set(names)].join(", ") || "none"})`,
      );
    }
    const { [instanceMatch]: _removed, ...rest } = current;
    const nextDecl = declarationOf(places, rest);
    resolveContent(nextDecl, places);
    const was = declarationOf(places, current).find((entry) => entry.name === instanceMatch);
    return {
      result: { removed: instanceMatch, wasClone: was?.kind === "github", declaration: nextDecl },
      next: instanceFileWith(file, "content", rest),
    };
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
 * Add the MCP server `name` to the instance configuration of `agent`.
 */
export async function addMcpServer(
  agent: string | AgentDefinition,
  name: string,
  server: McpServerInput,
  instance?: ContentInstance,
): Promise<McpEdit> {
  const places = await placesFor(agent, instance);
  const literals = await editInstanceFile(places, (file) => {
    const servers = mcpServersOf(file, places);
    if (Object.hasOwn(servers, name)) {
      throw new McpError("configuration", `already declared in ${places.config}`, name);
    }
    const next = { ...file, mcpServers: { ...servers, [name]: server } };
    const declared = declareMcp(places.programMcp, places.dir, instanceValues(places, next), places.programFile);
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
 * Remove the MCP server `name` from the instance configuration of `agent`.
 */
export async function removeMcpServer(
  agent: string | AgentDefinition,
  name: string,
  instance?: ContentInstance,
): Promise<McpEdit> {
  const places = await placesFor(agent, instance);
  await editInstanceFile(places, (file) => {
    const servers = mcpServersOf(file, places);
    if (!Object.hasOwn(servers, name)) {
      const programs = declareMcp(places.programMcp, places.dir, undefined, places.programFile).map((d) => d.name);
      throw new McpError(
        "configuration",
        programs.includes(name)
          ? `declared by the program (${places.programFile}), which is read and never edited`
          : `no MCP server named "${name}" in ${places.config}`,
        name,
      );
    }
    const { [name]: _removed, ...rest } = servers;
    const next = instanceFileWith(file, "mcpServers", rest);
    declareMcp(places.programMcp, places.dir, instanceValues(places, next), places.programFile);
    return { result: undefined, next };
  });
  return { name, notes: [] };
}

function declarationOf(places: Places, instanceEntries: Record<string, ContentEntry>): DeclaredContent[] {
  return joinContent(
    declareContent(places.programContent, { origin: "program", file: places.programFile }),
    declareContent(instanceEntries, { origin: "instance", file: places.config, base: dirname(places.config) }),
  );
}

function readInstanceContent(places: Places): Record<string, ContentEntry> {
  const text = textIfExists(places.config);
  return text === undefined ? {} : contentOf(parseInstanceFile(text, places.config), places);
}

function contentOf(file: Record<string, unknown>, places: Places): Record<string, ContentEntry> {
  const content = file.content;
  if (content === undefined) return {};
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new Error(`${places.config}: "content" must be an object of entries by name`);
  }
  return content as Record<string, ContentEntry>;
}

function mcpServersOf(file: Record<string, unknown>, places: Places): Record<string, unknown> {
  const servers = file.mcpServers;
  if (servers === undefined) return {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new McpError("configuration", `${places.config}: "mcpServers" must be an object`);
  }
  return servers as Record<string, unknown>;
}

async function editInstanceFile<T>(
  places: Places,
  edit: (file: Record<string, unknown>) => { result: T; next: Record<string, unknown> },
): Promise<T> {
  return withLockedFile(
    places.config,
    async (): Promise<LockResult<T>> => {
      const text = textIfExists(places.config);
      const out = edit(text === undefined ? {} : parseInstanceFile(text, places.config));
      writeFileAtomic(places.config, `${JSON.stringify(out.next, null, 2)}\n`, fileMode(places.config));
      return { result: out.result };
    },
    { mode: fileMode(places.config), create: false },
  );
}

const instanceValues = (places: Places, values: Record<string, unknown>): McpInstance => ({
  values,
  label: places.config,
  directory: dirname(places.config),
});

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

function instanceFileWith(
  file: Record<string, unknown>,
  key: "content" | "mcpServers",
  entries: Record<string, unknown>,
): Record<string, unknown> {
  const { [key]: _replaced, ...rest } = file;
  return Object.keys(entries).length > 0 ? { ...rest, [key]: entries } : rest;
}

function instanceFileText(file: Record<string, unknown>, content: Record<string, ContentEntry>): string {
  return `${JSON.stringify(instanceFileWith(file, "content", content), null, 2)}\n`;
}

function textIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Set what the instance configuration says of the channel `channel` (`channels.<channel>` in `fastagent.json` or
 * `instance.config`).
 */
export async function setChannelConfig(
  agentDir: string,
  channel: string,
  entry: { ingress?: "webhook" | "connection"; app?: { id: string; team?: string; url?: string } },
  instance?: Pick<ContentInstance, "config">,
): Promise<void> {
  const config = instance?.config ?? join(resolveAgentDir(agentDir), INSTANCE_CONFIG_FILE);
  await withLockedFile(
    config,
    async (): Promise<LockResult<undefined>> => {
      const text = textIfExists(config);
      const file = text === undefined ? {} : parseInstanceFile(text, config);
      const channels = (file.channels ?? {}) as Record<string, Record<string, unknown>>;
      const next = { ...file, channels: { ...channels, [channel]: { ...channels[channel], ...entry } } };
      writeFileAtomic(config, `${JSON.stringify(next, null, 2)}\n`, fileMode(config));
      return { result: undefined };
    },
    { mode: fileMode(config), create: false },
  );
}

/** The mode a rewrite of `path` keeps: its own, or the definition's default for a new one. */
function fileMode(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat === undefined ? INSTANCE_FILE_MODE : stat.mode & 0o777;
}
