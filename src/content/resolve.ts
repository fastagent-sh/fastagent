/**
 * WHERE each declared content entry is, for THIS instance: the one answer the prompt, the coding tools, skills,
 * authored tools, `info` and `deploy` all read (docs/design/core.md §2). An entry is at `content/<name>` everywhere;
 * what is there is this place's: a link to a directory of this machine, a clone fastagent made, or nothing. Reads the
 * disk (git included); never the network, never a write. Making a clone real is `cloneContent`'s, and only a process
 * that runs the agent asks for it.
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { contentEntryPath } from "../paths.ts";
import { type DeclaredContent, nestingError } from "./declare.ts";
import { type CloneOutcome, checkoutProblem, refNotice, refreshClone } from "./git.ts";
import { ensureContentDir } from "./mount.ts";

/** A declared content entry, resolved for this instance. */
export type ResolvedContent = {
  /** Unique within the agent, ignoring case; one path segment. */
  name: string;
  /** The agent knows it and does not write it. */
  readonly: boolean;
  /** What the declaration tells the agent about it. */
  description?: string;
  /** `content/<name>` in the agent directory, absolute: where the agent reaches it on every instance. */
  location: string;
  /** The directory of this machine `location` links to, when it is a link. */
  linkedTo?: string;
  /** What to tell the user about how it resolved: a checkout off its `ref`, a clone not made yet. */
  notices: string[];
} & (
  | {
      /** A directory of each machine that links one. */
      kind: "local";
    }
  | {
      kind: "github";
      /** `owner/repo`. */
      repo: string;
      ref?: string;
      /**
       * A clone fastagent makes at `location` and brings up to date at each start while it holds nothing of the
       * agent's. False when `location` links to the user's own checkout, which is never touched.
       */
      clone: boolean;
    }
);

/** Resolve the agent's `declared` content. Refuses, naming the entry, what cannot be. */
export function resolveContent(agentDir: string, declared: readonly DeclaredContent[]): ResolvedContent[] {
  return declared.filter((entry) => !isAbsent(agentDir, entry)).map((entry) => resolveOne(agentDir, entry));
}

/**
 * The declared `local` entries this instance does not have: nothing is at `content/<name>`, because this machine (a
 * host, a teammate's laptop) has no such directory linked. Not an error: the declaration says the data lives on the
 * machines that link it. Whoever opens the agent says which they are, since the agent is not told of them.
 */
export function contentAbsentHere(agentDir: string, declared: readonly DeclaredContent[]): DeclaredContent[] {
  return declared.filter((entry) => isAbsent(agentDir, entry));
}

function isAbsent(agentDir: string, entry: DeclaredContent): boolean {
  return entry.kind === "local" && lstatOrMissing(contentEntryPath(agentDir, entry.name)) === undefined;
}

function resolveOne(agentDir: string, entry: DeclaredContent): ResolvedContent {
  const { name, readonly, description } = entry;
  const location = contentEntryPath(agentDir, name);
  const base = { name, readonly, ...(description !== undefined ? { description } : {}), location };
  const found = lstatOrMissing(location);
  if (found?.isSymbolicLink()) {
    const linkedTo = linkTarget(location, name);
    const notices = checkLinkTarget(agentDir, entry, linkedTo, `content/${name} links to ${linkedTo}, which`);
    if (entry.kind === "local") return { ...base, linkedTo, notices, kind: "local" };
    return { ...base, linkedTo, notices, ...github(entry), clone: false };
  }
  if (found && !found.isDirectory()) throw new Error(`content "${name}": ${location} is not a directory`);
  // A directory this place put there itself: for a github entry, fastagent's clone.
  if (entry.kind === "local") return { ...base, notices: [], kind: "local" };
  const notices = found ? [] : ["not cloned yet: it is cloned when the agent starts"];
  return { ...base, notices, ...github(entry), clone: true };
}

function github(entry: Extract<DeclaredContent, { kind: "github" }>) {
  return { kind: "github" as const, repo: entry.repo, ...(entry.ref !== undefined ? { ref: entry.ref } : {}) };
}

/** Where the link `location` points, resolved; a link to nothing is refused with what it names. */
function linkTarget(location: string, name: string): string {
  try {
    return realpathSync(location);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `content "${name}": content/${name} links to ${resolve(dirname(location), readlinkSync(location))}, which does ` +
        `not exist — link it again, or remove the link`,
    );
  }
}

/**
 * Whether `content/<name>` can link to `target` for `entry`: a directory of this machine, apart from the agent
 * directory, and for a github entry the root of a checkout of its repository. Returns what to tell the user (a
 * checkout off its `ref`); refuses, naming the entry, what cannot be. `what` says `target` in the refusal.
 */
export function checkLinkTarget(agentDir: string, entry: DeclaredContent, target: string, what = target): string[] {
  const stat = statOrMissing(target);
  if (!stat) throw new Error(`content "${entry.name}": ${what} does not exist`);
  if (!stat.isDirectory()) throw new Error(`content "${entry.name}": ${what} is not a directory`);
  // The declaration was checked as written; a symlink can still put one inside the other, so ask of the real paths —
  // including for an agent directory `init` is about to create, which a symlinked ancestor still places.
  const nested = nestingError(realPathOf(agentDir), realpathSync(target), entry.name);
  if (nested) throw new Error(nested);
  if (entry.kind !== "github") return [];
  const problem = checkoutProblem(target, entry.repo);
  if (problem) throw new Error(`content "${entry.name}": ${what} ${problem}`);
  const offRef = entry.ref === undefined ? undefined : refNotice(target, entry.ref);
  return offRef ? [offRef] : [];
}

/**
 * Make a clone real, or bring it up to date at its `ref` in place, by git's rules, which never overwrite what the
 * agent did in it (git.ts `refreshClone`): what git refuses, or a remote that cannot be reached, keeps it as it is,
 * with the reason. Only a process that runs the agent calls this. The user's own checkout is never cloned over.
 */
export async function cloneContent(entry: Extract<ResolvedContent, { kind: "github" }>): Promise<CloneOutcome> {
  if (!entry.clone) throw new Error(`content "${entry.name}" links to the checkout ${entry.linkedTo}, not a clone`);
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
