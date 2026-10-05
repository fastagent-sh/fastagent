/**
 * WHERE each declared context is, for THIS instance: the one answer the prompt, the coding tools, skills, authored
 * tools, `info` and `deploy` all read (docs/design/agent-model-implementation.md §2). Reads the declaration and the
 * disk; never the network, never a write.
 */
import { realpathSync, statSync } from "node:fs";
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
  /** Its absolute directory on this instance. */
  location: string;
}

/** Where this instance runs: this machine, or a deployed host. */
export type Place = "local" | "host";

/** Resolve the raw `contexts` declaration of the agent in `agentDir`. Refuses, naming the context, what cannot be. */
export function resolveContexts(
  agentDir: string,
  declaration: unknown,
  place: Place = isDeployedWorkspace() ? "host" : "local",
): ResolvedContext[] {
  return declareContexts(declaration, agentDir).map((context) => resolveOne(agentDir, context, place));
}

function resolveOne(agentDir: string, context: DeclaredContext, place: Place): ResolvedContext {
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
  if (!stat) throw new Error(`context "${context.name}": ${path} does not exist`);
  if (!stat.isDirectory()) throw new Error(`context "${context.name}": ${path} is not a directory`);
  // The declaration was checked as written; a symlink can still put one inside the other, so ask again of the real
  // paths. An agent directory `init` is about to create has no real path yet, and needs none: nothing links into it.
  const nested = nestingError(realOrAsIs(agentDir), realpathSync(path), context.name);
  if (nested) throw new Error(nested);
  return { name: context.name, kind: context.kind, readonly: context.readonly, location: path };
}

function realOrAsIs(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
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
