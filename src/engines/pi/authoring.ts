/**
 * Creating an agent and editing its contexts, as an API: `fastagent init` and `fastagent context` are thin CLI wrappers
 * over these, so the CLI and a client (a desktop app) cannot disagree about the rules. Nothing here prints or exits;
 * every refusal is thrown with the message the CLI shows.
 */
import { resolve } from "node:path";
import { resolveAgentDir } from "../../paths.ts";
import { type ScaffoldOptions, scaffoldAgent } from "../../scaffold/init.ts";
import { type ContextDeclaration, declareContexts, defaultContextName, isContextName } from "../../contexts/declare.ts";
import { type ResolvedContext, resolveContexts } from "../../contexts/resolve.ts";
import { loadConfig, writeContexts } from "./config.ts";

/**
 * A refusal about a context's NAME: one that cannot name a context, one the agent already has, one it does not have.
 * The caller can fix it by naming another (the CLI exits 2 and asks for `--name`).
 */
export class ContextNameError extends Error {
  override name = "ContextNameError";
}

export interface CreateAgentOptions extends ScaffoldOptions {
  /** What the agent works on and knows, written into `fastagent.config.ts`. */
  contexts?: ContextDeclaration[];
}

export interface CreatedAgent {
  /** The agent directory, absolute. */
  dir: string;
  /** The files written, relative to `dir`. */
  created: string[];
  /** The contexts, resolved for this instance. */
  contexts: ResolvedContext[];
}

/**
 * Create an agent in `dir`, which must be new or empty. Every context is checked before anything is written, and the
 * scaffold is removed again when writing the contexts fails. Without `exampleTool` the agent imports nothing at run
 * time, so it runs without `npm install`.
 */
export async function createAgent(dir: string, options: CreateAgentOptions = {}): Promise<CreatedAgent> {
  const agentDir = resolve(dir);
  const declarations = options.contexts ?? [];
  const contexts = resolveContexts(agentDir, declarations);
  const { created, undo } = await scaffoldAgent(agentDir, { exampleTool: options.exampleTool });
  // The contexts were checked above, so a refusal here is one that check could not foresee (the disk changed in
  // between); the scaffold goes with it, or a retry would find "already an agent" holding no contexts.
  if (declarations.length > 0) {
    await writeContexts(agentDir, declarations).catch(async (error: unknown) => {
      await undo();
      throw error;
    });
  }
  return { dir: agentDir, created, contexts };
}

/** The agent's contexts, resolved for this instance (what `fastagent context list` shows). */
export async function listContexts(agentDir: string): Promise<ResolvedContext[]> {
  const dir = resolveAgentDir(agentDir);
  return resolveContexts(dir, await declared(dir));
}

/** What an edit leaves: the context it added or removed, by name, and the agent's contexts after it. */
export interface ContextEdit {
  name: string;
  contexts: ResolvedContext[];
}

/**
 * Add a context to the agent in `agentDir`. It is named `declaration.name`, or after its repository or directory;
 * a name that cannot be one, or that the agent already has (ignoring case), is a {@link ContextNameError}.
 */
export async function addContext(agentDir: string, declaration: ContextDeclaration): Promise<ContextEdit> {
  const dir = resolveAgentDir(agentDir);
  const declarations = await declared(dir);
  const name = declaration.name ?? defaultContextName(declaration);
  if (!isContextName(name)) {
    throw new ContextNameError(`"${name}" cannot name a context (one path segment of letters, digits, "-" and "_")`);
  }
  const taken = declareContexts(declarations, dir).find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new ContextNameError(`this agent already has a context named "${taken.name}"`);
  const next = [...declarations, declaration];
  await writeContexts(dir, next);
  return { name, contexts: resolveContexts(dir, next) };
}

/** Remove the agent's context named `name` (ignoring case); a name it does not have is a {@link ContextNameError}. */
export async function removeContext(agentDir: string, name: string): Promise<ContextEdit> {
  const dir = resolveAgentDir(agentDir);
  const declarations = await declared(dir);
  const names = declareContexts(declarations, dir).map((c) => c.name);
  const index = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
  if (index === -1) {
    throw new ContextNameError(`no context named "${name}" (this agent has: ${names.join(", ") || "none"})`);
  }
  const next = declarations.filter((_, i) => i !== index);
  await writeContexts(dir, next);
  return { name: names[index] as string, contexts: resolveContexts(dir, next) };
}

/** The agent's declarations as written (not resolved: an edit rewrites what the author wrote). */
async function declared(agentDir: string): Promise<ContextDeclaration[]> {
  return (await loadConfig(agentDir)).config.contexts ?? [];
}
