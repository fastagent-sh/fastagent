/**
 * Creating an agent and editing its contexts, as an API: `fastagent init` and `fastagent context` are thin CLI wrappers
 * over these, so the CLI and a client (a desktop app) cannot disagree about the rules. Nothing here prints or exits;
 * every refusal is thrown with the message the CLI shows.
 */
import { resolve } from "node:path";
import { resolveAgentDir } from "../../paths.ts";
import { type ScaffoldOptions, initRepository, scaffoldAgent } from "../../scaffold/init.ts";
import { type ContextDeclaration, declareContexts, defaultContextName, isContextName } from "../../contexts/declare.ts";
import { type ResolvedContext, resolveContexts } from "../../contexts/resolve.ts";
import { editContexts, loadConfig, writeContexts } from "./config.ts";

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
  /**
   * Install the agent's dependencies, after the scaffold and before its first commit, so the lockfile is in that
   * commit. The CLI passes `npm install` (its scaffold carries web access); without `webAccess` nothing needs
   * installing. A rejection is a failed create: the scaffold is removed again and the error thrown, as when writing
   * the contexts fails, so the directory is empty for a retry. One that reports its failure some other way (the CLI's
   * resolves, and says the install failed) leaves the agent created.
   */
  install?: (dir: string) => Promise<void>;
}

export interface CreatedAgent {
  /** The agent directory, absolute. */
  dir: string;
  /** The files written, relative to `dir`. */
  created: string[];
  /** The contexts, resolved for this instance. */
  contexts: ResolvedContext[];
  /**
   * What became of the agent's git repository, as a sentence to show: created with the scaffold as its first commit,
   * or why not (inside a repository that tracks it, git missing, no commit identity).
   */
  repository: string;
}

/**
 * Create an agent in `dir`, which must be new or empty. Every context is checked before anything is written, and the
 * scaffold is removed again when writing the contexts fails. It runs without `npm install`; with `webAccess`, its web
 * tools load only once `npm install` has installed `@fastagent-sh/pi-web-access`, and until then are left out with a warning. The
 * agent is then a git repository whose first commit is what was written:
 * it changes itself, and version control is how its author goes back to a version that worked.
 */
export async function createAgent(dir: string, options: CreateAgentOptions = {}): Promise<CreatedAgent> {
  const agentDir = resolve(dir);
  const declarations = options.contexts ?? [];
  for (const [i, declaration] of declarations.entries()) contextName(agentDir, declarations.slice(0, i), declaration);
  const contexts = resolveContexts(agentDir, declarations);
  const { created, undo } = await scaffoldAgent(agentDir, { webAccess: options.webAccess });
  // The contexts were checked above, so a refusal here is one that check could not foresee (the disk changed in
  // between); the scaffold goes with it, or a retry would find "already an agent" holding no contexts.
  if (declarations.length > 0) {
    await writeContexts(agentDir, declarations).catch(async (error: unknown) => {
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
  return { dir: agentDir, created, contexts, repository: await initRepository(agentDir) };
}

/** The agent's contexts, resolved for this instance (what `fastagent context list` shows). */
export async function listContexts(agentDir: string): Promise<ResolvedContext[]> {
  const dir = resolveAgentDir(agentDir);
  return resolveContexts(dir, (await loadConfig(dir)).config.contexts);
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
  const { name, contexts } = await editContexts(dir, (declared) => {
    const next = [...declared, declaration];
    return { contexts: next, result: { name: contextName(dir, declared, declaration), contexts: next } };
  });
  return { name, contexts: resolveContexts(dir, contexts) };
}

/** Remove the agent's context named `name` (ignoring case); a name it does not have is a {@link ContextNameError}. */
export async function removeContext(agentDir: string, name: string): Promise<ContextEdit> {
  const dir = resolveAgentDir(agentDir);
  const removed = await editContexts(dir, (declared) => {
    const names = declareContexts(declared, dir).map((c) => c.name);
    const index = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    if (index === -1) {
      throw new ContextNameError(`no context named "${name}" (this agent has: ${names.join(", ") || "none"})`);
    }
    const next = declared.filter((_, i) => i !== index);
    return { contexts: next, result: { name: names[index] as string, contexts: next } };
  });
  return { name: removed.name, contexts: resolveContexts(dir, removed.contexts) };
}

/**
 * The name `declaration` takes beside the `declared` ones: its own, or its repository's or directory's. One that cannot
 * name a context, or that one of them has (ignoring case), is a {@link ContextNameError}.
 */
function contextName(agentDir: string, declared: ContextDeclaration[], declaration: ContextDeclaration): string {
  const name = declaration.name ?? defaultContextName(declaration);
  if (!isContextName(name)) {
    throw new ContextNameError(`"${name}" cannot name a context (one path segment of letters, digits, "-" and "_")`);
  }
  const taken = declareContexts(declared, agentDir).find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new ContextNameError(`this agent already has a context named "${taken.name}"`);
  return name;
}
