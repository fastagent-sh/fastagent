/**
 * WHERE each declared context is, for THIS instance: the one answer the prompt, the coding tools, skills, authored
 * tools, `info` and `deploy` all read (docs/design/core.md §2). Reads the declaration and the
 * disk (git included); never the network, never a write. Making a clone real is `cloneContext`'s, and only a process
 * that runs the agent asks for it.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeployedWorkspace, resolveContextsDir } from "../paths.ts";
import { type DeclaredContext, declareContexts, nestingError } from "./declare.ts";
import { type CloneOutcome, checkoutProblem, refNotice, refreshClone } from "./git.ts";

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
      /** A directory of this machine, which a host does not have. */
      kind: "local";
    }
  | {
      kind: "github";
      /** `owner/repo`. */
      repo: string;
      ref?: string;
      /**
       * A clone in the instance's state, brought up to date at each start while it holds nothing of the agent's:
       * there is no checkout of the repository on this machine to use. False when it is the user's own checkout,
       * which is never touched.
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
  return declareContexts(declaration, agentDir)
    .filter((context) => !absentFrom(place, context))
    .map((context) => resolveOne(agentDir, context, place));
}

/**
 * The contexts declared that this instance does not have, by their type: a `local` one is a directory of the
 * author's machine, so a host has none (agent-model.md §3). Not an error: the declaration says where the data lives.
 * Whoever opens the agent says which they are, since the agent is not told of them.
 */
export function contextsAbsentHere(
  agentDir: string,
  declaration: unknown,
  place: Place = isDeployedWorkspace() ? "host" : "local",
): Extract<DeclaredContext, { kind: "local" }>[] {
  return declareContexts(declaration, agentDir).filter((context) => absentFrom(place, context));
}

function absentFrom(place: Place, context: DeclaredContext): context is Extract<DeclaredContext, { kind: "local" }> {
  return place === "host" && context.kind === "local";
}

function resolveOne(agentDir: string, context: DeclaredContext, place: Place): ResolvedContext {
  const { name, readonly } = context;
  if (context.kind === "github") {
    const { repo, ref } = context;
    // A host has no checkout of the user's: the `local` a declaration names is a path on the author's machine.
    const checkout = place === "host" ? undefined : context.checkout;
    const github = { kind: "github" as const, repo, ...(ref !== undefined ? { ref } : {}) };
    // The user's own checkout, used as it is: never fetched, never moved to `ref`, only said to be off it.
    const problem = checkout === undefined ? undefined : checkoutProblem(checkout, repo);
    if (checkout !== undefined && problem === undefined) {
      refuseNesting(agentDir, checkout, name);
      const offRef = ref === undefined ? undefined : refNotice(checkout, ref);
      return { name, readonly, location: checkout, notices: offRef ? [offRef] : [], ...github, clone: false };
    }
    // No checkout to use, so the instance clones it, into its own storage under the context's name.
    const location = join(resolveContextsDir(agentDir), name);
    const notices = [
      ...(problem ? [`${checkout} ${problem}, so github ${repo} is cloned instead`] : []),
      ...(existsSync(location) ? [] : ["not cloned yet: it is cloned when the agent starts"]),
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
 * Make a clone real, or bring it up to date at its `ref` in place, by git's rules, which never overwrite what the
 * agent did in it (git.ts `refreshClone`): what git refuses, or a remote that cannot be reached, keeps it as it is,
 * with the reason. Only a process that runs the agent calls this. The user's own checkout is never cloned over.
 */
export async function cloneContext(context: Extract<ResolvedContext, { kind: "github" }>): Promise<CloneOutcome> {
  if (!context.clone) throw new Error(`context "${context.name}" is the checkout at ${context.location}, not a clone`);
  return refreshClone(context.repo, context.ref, context.location).catch((error: unknown) => {
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
