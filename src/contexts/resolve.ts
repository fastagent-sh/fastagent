/**
 * WHERE each declared context is, for THIS instance: the one answer the prompt, the coding tools, skills, authored
 * tools, `info` and `deploy` all read (docs/design/agent-model-implementation.md §2). Reads the declaration and the
 * disk; never the network, never a write.
 */
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeployedWorkspace } from "../paths.ts";
import { type DeclaredContext, declareContexts, nestingError } from "./declare.ts";

/** A declared context, resolved for this instance. */
export interface ResolvedContext {
  /** Unique within the agent, ignoring case; one path segment. */
  name: string;
  /** How it reaches an instance: a directory on this machine, one a host gets a copy of, or a repository. */
  kind: "local" | "copy" | "github";
  /** The agent knows it and does not write it. */
  readonly: boolean;
  /** The agent's working directory: it works there, and what it creates lands there. At most one. */
  workdir: boolean;
  /** Its absolute directory on this instance. */
  location: string;
}

/** Where this instance runs: this machine, or a deployed host. */
export type Place = "local" | "host";

/**
 * Resolve the raw `contexts` declaration of the agent in `agentDir`. Refuses, naming the context, what cannot be.
 * `toCreate` names a directory the caller is about to create (`--workdir` on a folder that does not exist yet): it is
 * checked as the path it will have, instead of refused as missing.
 */
export function resolveContexts(
  agentDir: string,
  declaration: unknown,
  options: { place?: Place; toCreate?: string } = {},
): ResolvedContext[] {
  const place = options.place ?? (isDeployedWorkspace() ? "host" : "local");
  return declareContexts(declaration, agentDir).map((context) =>
    resolveOne(agentDir, context, place, options.toCreate),
  );
}

/**
 * The agent's two directories, carried together so no reader picks a cwd of its own: the agent directory (its
 * definition and instance state) and the working directory (where it works). docs/design/agent-model-implementation.md
 * §3.11.
 */
export interface AgentDirs {
  agentDir: string;
  cwd: string;
}

/** THE working directory: the context declared `workdir`, else the agent directory. */
export function agentDirs(agentDir: string, contexts: readonly ResolvedContext[]): AgentDirs {
  return { agentDir, cwd: contexts.find((context) => context.workdir)?.location ?? agentDir };
}

function resolveOne(agentDir: string, context: DeclaredContext, place: Place, toCreate?: string): ResolvedContext {
  if (context.kind === "github") {
    throw new Error(
      `context "${context.name}": github contexts are not supported yet — declare the checkout as { local: "<path>" }`,
    );
  }
  if (place === "host") {
    throw new Error(`context "${context.name}": a deployment does not carry contexts yet`);
  }
  const { path } = context;
  const stat = statOrMissing(path);
  const pending = !stat && path === toCreate;
  if (!stat && !pending) throw new Error(`context "${context.name}": ${path} does not exist`);
  if (stat && !stat.isDirectory()) throw new Error(`context "${context.name}": ${path} is not a directory`);
  // The declaration was checked as written; a symlink can still put one inside the other, so ask again of the real
  // paths — including for a directory a command is about to create (the agent's, or a new working directory), which a
  // symlinked ancestor still places.
  const nested = nestingError(realPathOf(agentDir), realPathOf(path), context.name);
  if (nested) throw new Error(nested);
  return {
    name: context.name,
    kind: context.kind,
    readonly: context.readonly,
    workdir: context.workdir,
    location: path,
  };
}

/**
 * Where `path` really is, whether or not it exists yet: its nearest existing ancestor resolved, and the segments below
 * it appended as written. A directory that does not exist yet links nowhere itself, but an ancestor can.
 */
function realPathOf(path: string): string {
  const below: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...below.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      below.push(basename(current));
    }
  }
}

function statOrMissing(path: string) {
  try {
    return statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}
