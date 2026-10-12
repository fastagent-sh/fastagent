/**
 * WHERE each content entry is, for THIS instance: the one answer the prompt, the coding tools, authored tools, `info`
 * and `deploy` all read (docs/design/core.md §2). A repository `context.json` declares is fastagent's clone at
 * `content/<name>`, or this machine's own checkout of it where `context.local.json` binds one; a directory only this
 * machine has is where its binding says. Reads the disk (git included); never the network, never a write. Making a
 * clone real is `cloneContent`'s, and only a process that runs the agent asks for it.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CONTEXT_FILE, LOCAL_CONTEXT_FILE, contentEntryPath } from "../paths.ts";
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
  /** The context that declares it; undefined for the agent's own. */
  context?: string;
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
  refuseOneNameEach(declared, bound);
  const shared = declared.map((entry) =>
    resolveRepository(
      agentDir,
      entry,
      bound.find((binding) => binding.kind === "checkout" && binding.name.toLowerCase() === entry.name.toLowerCase()),
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

/**
 * The checkout bindings no entry declares: this machine's leftovers after an entry was renamed, removed, or withdrawn
 * by a context refresh. Nothing is written for them and they are never read as local content — what is left here is
 * said, and the file is the user's to edit.
 */
export function staleCheckouts({ declared, bound }: ContentDeclaration): BoundContent[] {
  return bound.filter(
    (binding) =>
      binding.kind === "checkout" && !declared.some((entry) => entry.name.toLowerCase() === binding.name.toLowerCase()),
  );
}

/** What is said of a binding {@link staleCheckouts} returns, after the word "content". */
export function staleCheckoutNotice(binding: BoundContent): string {
  return (
    `${binding.name}: bound in ${LOCAL_CONTEXT_FILE} to ${binding.path} as this machine's checkout, which no content ` +
    `entry declares: the agent is not told of it (fastagent content remove ${binding.name})`
  );
}

/**
 * Content names are unique across the agent, ignoring case: one becomes a directory, and some filesystems do not tell
 * two apart. A directory of this machine under a declared entry's name is the one collision the reader can name both
 * sides of.
 */
function refuseOneNameEach(declared: readonly DeclaredContent[], bound: readonly BoundContent[]): void {
  for (const binding of bound) {
    if (binding.kind !== "local") continue;
    const entry = declared.find((one) => one.name.toLowerCase() === binding.name.toLowerCase());
    if (entry !== undefined) {
      throw new Error(
        `content "${binding.name}" is declared in ${CONTEXT_FILE} and bound as a directory of this machine in ` +
          `${LOCAL_CONTEXT_FILE}: the checkout of a declared entry goes in "checkouts"`,
      );
    }
  }
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
    ...(entry.context !== undefined ? { context: entry.context } : {}),
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
export async function cloneContent(entry: Extract<ResolvedContent, { kind: "github" }>): Promise<CloneOutcome> {
  if (!entry.clone) throw new Error(`content "${entry.name}" is bound to the checkout ${entry.location}, not a clone`);
  ensureContentDir(dirname(entry.location));
  return refreshClone(entry.repo, entry.ref, entry.location).catch((error: unknown) => {
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
