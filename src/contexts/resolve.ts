/**
 * WHERE each declared context is, for THIS instance: the one answer the prompt, the coding tools, skills, authored
 * tools, `info` and `deploy` all read (docs/design/agent-model-implementation.md §2). Reads the declaration and the
 * disk (git included); never the network, never a write. Making a clone real is `cloneContext`'s, and only a process
 * that runs the agent asks for it.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeployedWorkspace, resolveStateRoot } from "../paths.ts";
import { type DeclaredContext, declareContexts, nestingError } from "./declare.ts";
import { checkoutProblem, freshClone, refNotice } from "./git.ts";

/** A declared context, resolved for this instance. */
export type ResolvedContext = {
  /** Unique within the agent, ignoring case; one path segment. */
  name: string;
  /** The agent knows it and does not write it. */
  readonly: boolean;
  /** Its absolute directory on this instance. */
  location: string;
  /** What to tell the user about how it resolved: a checkout off its `ref`, a clone not made yet. */
  notices: string[];
} & (
  | {
      /** How it reaches an instance: a directory on this machine, or one a host gets a copy of. */
      kind: "local" | "copy";
    }
  | {
      kind: "github";
      /** `owner/repo`. */
      repo: string;
      ref?: string;
      /**
       * A clone made afresh each time the agent starts, in the instance's state: there is no checkout of the
       * repository on this machine to use. False when it is the user's own checkout, which is never synchronized.
       */
      clone: boolean;
    }
);

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
  if (place === "host") {
    throw new Error(`context "${context.name}": a deployment does not carry contexts yet`);
  }
  const { name, readonly } = context;
  if (context.kind === "github") {
    const { repo, ref, checkout } = context;
    const github = { kind: "github" as const, repo, ...(ref !== undefined ? { ref } : {}) };
    // The user's own checkout, used as it is: never fetched, never moved to `ref`, only said to be off it.
    const problem = checkout === undefined ? undefined : checkoutProblem(checkout, repo);
    if (checkout !== undefined && problem === undefined) {
      refuseNesting(agentDir, checkout, name);
      const offRef = ref === undefined ? undefined : refNotice(checkout, ref);
      return { name, readonly, location: checkout, notices: offRef ? [offRef] : [], ...github, clone: false };
    }
    // No checkout to use, so the instance clones it, under its own state and the context's name.
    const location = join(resolveStateRoot(agentDir), "contexts", name);
    const notices = [
      ...(problem ? [`${checkout} ${problem}, so github ${repo} is cloned instead`] : []),
      ...(existsSync(location) ? [] : ["not cloned yet: it is cloned afresh each time the agent starts"]),
    ];
    return { name, readonly, location, notices, ...github, clone: true };
  }
  const { path } = context;
  const stat = statOrMissing(path);
  if (!stat) throw new Error(`context "${name}": ${path} does not exist`);
  if (!stat.isDirectory()) throw new Error(`context "${name}": ${path} is not a directory`);
  refuseNesting(agentDir, path, name);
  return { name, readonly, location: path, notices: [], kind: context.kind };
}

/**
 * The declaration was checked as written; a symlink can still put one inside the other, so ask again of the real
 * paths — including for an agent directory `init` is about to create, which a symlinked ancestor still places.
 */
function refuseNesting(agentDir: string, location: string, name: string): void {
  const nested = nestingError(realPathOf(agentDir), realpathSync(location), name);
  if (nested) throw new Error(nested);
}

/**
 * Make a clone real, as a fresh clone at its `ref`: what the agent did in the last one and did not push is gone (it is
 * told so). A clone already identical to a fresh one is kept rather than cloned again; one that cannot be checked,
 * for want of the remote, is kept with a `warning` saying so. Only a process that runs the agent calls this. The
 * user's own checkout is never cloned over.
 */
export async function cloneContext(
  context: Extract<ResolvedContext, { kind: "github" }>,
): Promise<{ cloned: boolean; warning?: string }> {
  if (!context.clone) throw new Error(`context "${context.name}" is the checkout at ${context.location}, not a clone`);
  return freshClone(context.repo, context.ref, context.location).catch((error: unknown) => {
    throw new Error(`context "${context.name}": ${(error as Error).message}`);
  });
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
