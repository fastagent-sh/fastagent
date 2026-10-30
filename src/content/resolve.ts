/**
 * WHERE each content entry is, for THIS instance: the one answer the prompt, the coding tools, authored tools, `info`
 * and `deploy` all read (docs/design/core.md §2). A repository `context.json` declares is fastagent's clone at
 * `content/<name>`, or this machine's own checkout of it where `context.local.json` binds one; a directory only this
 * machine has is where its binding says. Reads the disk (git included); never the network, never a write. Making a
 * clone real is `cloneContent`'s, and only a process that runs the agent asks for it.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LOCAL_CONTEXT_FILE, contentEntryPath } from "../paths.ts";
import { type BoundContent, type ContentDeclaration, type DeclaredContent, nestingError } from "./declare.ts";
import { type CloneOutcome, checkoutProblem, refNotice, refreshClone } from "./git.ts";
import { ensureContentDir } from "./mount.ts";

/** A content entry, resolved for this instance. */
export type ResolvedContent = {
  /** Unique within the agent, ignoring case; one path segment. */
  name: string;
  /** The agent knows it and does not write it. */
  readonly: boolean;
  /** What the declaration tells the agent about it. */
  description?: string;
  /** Where the agent reaches it on this instance, absolute. */
  location: string;
  /** What to tell the user about how it resolved: a checkout off its `ref`, a clone not made yet. */
  notices: string[];
} & (
  | {
      /** A directory only this machine has, bound in `context.local.json`. */
      kind: "local";
    }
  | {
      kind: "github";
      /** `owner/repo`. */
      repo: string;
      ref?: string;
      /**
       * A clone fastagent makes at `content/<name>` and brings up to date at each start while it holds nothing of the
       * agent's. False when this machine binds its own checkout, which is never touched.
       */
      clone: boolean;
    }
);

/** Resolve the agent's content for this instance. Refuses, naming the entry, what cannot be. */
export function resolveContent(agentDir: string, { declared, bound }: ContentDeclaration): ResolvedContent[] {
  const shared = declared.map((entry) =>
    resolveRepository(
      agentDir,
      entry,
      bound.find((binding) => binding.kind === "checkout" && binding.name === entry.name),
    ),
  );
  const local = bound
    .filter((binding) => binding.kind === "local" && statOrMissing(binding.path) !== undefined)
    .map((binding) => resolveLocal(agentDir, binding as Extract<BoundContent, { kind: "local" }>));
  return [...shared, ...local];
}

/**
 * The bindings of a directory only this machine has that point at nothing here: the directory was moved or removed.
 * Not an error, since the binding is this machine's alone; the agent is not told of it, and whoever opens the agent
 * says so.
 */
export function contentAbsentHere({ bound }: ContentDeclaration): BoundContent[] {
  return bound.filter((binding) => binding.kind === "local" && statOrMissing(binding.path) === undefined);
}

/** What is said of a binding {@link contentAbsentHere} returns, after the word "content". */
export function absentNotice(binding: BoundContent): string {
  return (
    `${binding.name}: bound in ${LOCAL_CONTEXT_FILE} to ${binding.path}, which does not exist here: the agent is ` +
    `not told of it`
  );
}

function resolveRepository(agentDir: string, entry: DeclaredContent, checkout?: BoundContent): ResolvedContent {
  const { name, readonly, description } = entry;
  const repository = {
    name,
    readonly,
    ...(description !== undefined ? { description } : {}),
    kind: "github" as const,
    repo: entry.repo,
    ...(entry.ref !== undefined ? { ref: entry.ref } : {}),
  };
  if (checkout !== undefined && statOrMissing(checkout.path) !== undefined) {
    const location = realpathSync(checkout.path);
    const notices = checkBinding(agentDir, name, location, entry);
    return { ...repository, location, notices, clone: false };
  }
  const location = contentEntryPath(agentDir, name);
  const found = lstatOrMissing(location);
  if (found?.isSymbolicLink()) {
    throw new Error(
      `content "${name}": content/${name} is a link, and content/ holds only the clones fastagent makes — remove ` +
        `the link, and bind a checkout of your own in ${LOCAL_CONTEXT_FILE} instead (fastagent content add <dir>)`,
    );
  }
  if (found && !found.isDirectory()) throw new Error(`content "${name}": ${location} is not a directory`);
  const notices = found ? [] : ["not cloned yet: it is cloned when the agent starts"];
  if (checkout !== undefined) {
    notices.unshift(`bound in ${LOCAL_CONTEXT_FILE} to ${checkout.path}, which does not exist here: the clone is used`);
  }
  return { ...repository, location, notices, clone: true };
}

function resolveLocal(agentDir: string, binding: Extract<BoundContent, { kind: "local" }>): ResolvedContent {
  const { name, readonly, description } = binding;
  const location = realpathSync(binding.path);
  checkBinding(agentDir, name, location);
  return {
    name,
    readonly,
    ...(description !== undefined ? { description } : {}),
    location,
    notices: [],
    kind: "local",
  };
}

/**
 * Whether the content `name` can be bound to the directory `target` of this machine: a directory, apart from the agent
 * directory, and for a declared repository the root of a checkout of it. Returns what to tell the user (a checkout off
 * its `ref`); refuses, naming the entry, what cannot be.
 */
export function checkBinding(
  agentDir: string,
  name: string,
  target: string,
  repository?: Pick<DeclaredContent, "repo" | "ref">,
): string[] {
  const stat = statOrMissing(target);
  if (!stat) throw new Error(`content "${name}": ${target} does not exist`);
  if (!stat.isDirectory()) throw new Error(`content "${name}": ${target} is not a directory`);
  // A symlink can still put one inside the other, so ask of the real paths — including for an agent directory `init`
  // is about to create, which a symlinked ancestor still places.
  const nested = nestingError(realPathOf(agentDir), realpathSync(target), name);
  if (nested) throw new Error(nested);
  if (repository === undefined) return [];
  const problem = checkoutProblem(target, repository.repo);
  if (problem) throw new Error(`content "${name}": ${target} ${problem}`);
  const offRef = repository.ref === undefined ? undefined : refNotice(target, repository.ref);
  return offRef ? [offRef] : [];
}

/**
 * Make a clone real, or bring it up to date at its `ref` in place, by git's rules, which never overwrite what the
 * agent did in it (git.ts `refreshClone`): what git refuses, or a remote that cannot be reached, keeps it as it is,
 * with the reason. Only a process that runs the agent calls this. A checkout this machine binds is never cloned over.
 */
export async function cloneContent(
  entry: Extract<ResolvedContent, { kind: "github" }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloneOutcome> {
  if (!entry.clone) throw new Error(`content "${entry.name}" is bound to the checkout ${entry.location}, not a clone`);
  ensureContentDir(dirname(entry.location));
  return refreshClone(entry.repo, entry.ref, entry.location, env).catch((error: unknown) => {
    throw new Error(`content "${entry.name}": ${(error as Error).message}`);
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

function lstatOrMissing(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
