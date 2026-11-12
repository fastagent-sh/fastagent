/**
 * WHERE each content entry is, for THIS instance: the one answer the prompt, the coding tools, authored tools, `info`
 * and `deploy` all read. A repository is fastagent's clone at `content/<name>` in the
 * instance's working directory; a directory is where the instance configuration says. Reads the disk (git included);
 * never the network, never a write. Making a clone real is `cloneContent`'s, and only a process that runs the agent
 * asks for it.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { contentEntryPath } from "../paths.ts";
import type { DeclaredContent } from "./declare.ts";
import { type CloneOutcome, refreshClone } from "./git.ts";
import { ensureContentDir } from "./mount.ts";

/** A content entry, resolved for this instance. */
export type ResolvedContent = {
  /** Unique within the agent, ignoring case; one path segment. */
  name: string;
  /** What the declaration tells the agent about it. */
  description?: string;
  /** Where the agent reaches it on this instance, absolute. */
  location: string;
  /** What to tell the user about how it resolved: a clone not made yet. */
  notices: string[];
} & (
  | {
      /** A directory of this machine, where the instance configuration says. */
      kind: "local";
    }
  | {
      /** A clone fastagent makes at `content/<name>` and brings up to date at each start while it holds nothing of the agent's. */
      kind: "github";
      /** `owner/repo`. */
      repo: string;
      ref?: string;
    }
);

/** Where an instance's content is resolved. */
export interface ContentPlaces {
  /** The instance's working directory, where clones are made. */
  workdir: string;
}

/** Resolve the agent's content for this instance. Refuses, naming the entry, what cannot be. */
export function resolveContent(declared: readonly DeclaredContent[], places: ContentPlaces): ResolvedContent[] {
  return declared.map((entry) => (entry.kind === "github" ? resolveRepository(places, entry) : resolveLocal(entry)));
}

function resolveRepository(
  { workdir }: ContentPlaces,
  entry: Extract<DeclaredContent, { kind: "github" }>,
): ResolvedContent {
  const { name, description } = entry;
  const location = contentEntryPath(workdir, name);
  const found = lstatOrMissing(location);
  if (found?.isSymbolicLink()) {
    throw new Error(
      `content "${name}": content/${name} is a link, and content/ holds only the clones fastagent makes — remove ` +
        `the link, and add the directory it points at as content of its own (fastagent content add <dir>)`,
    );
  }
  if (found && !found.isDirectory()) throw new Error(`content "${name}": ${location} is not a directory`);
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    kind: "github",
    repo: entry.repo,
    ...(entry.ref !== undefined ? { ref: entry.ref } : {}),
    location,
    notices: found ? [] : ["not cloned yet: it is cloned when the agent starts"],
  };
}

function resolveLocal(entry: Extract<DeclaredContent, { kind: "local" }>): ResolvedContent {
  const { name, description } = entry;
  checkDirectory(name, entry.path);
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    kind: "local",
    location: realpathSync(entry.path),
    notices: [],
  };
}

/** Whether the content `name` can be the directory `target` of this machine: one that exists. Refuses, naming the entry, what cannot be. */
export function checkDirectory(name: string, target: string): void {
  const stat = statOrMissing(target);
  if (!stat) throw new Error(`content "${name}": ${target} does not exist`);
  if (!stat.isDirectory()) throw new Error(`content "${name}": ${target} is not a directory`);
}

/**
 * Make a clone real, or bring it up to date at its `ref` in place, by git's rules, which never overwrite what the
 * agent did in it (git.ts `refreshClone`): what git refuses, or a remote that cannot be reached, keeps it as it is,
 * with the reason. Only a process that runs the agent calls this.
 */
export async function cloneContent(
  entry: Extract<ResolvedContent, { kind: "github" }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloneOutcome> {
  ensureContentDir(dirname(entry.location));
  return refreshClone(entry.repo, entry.ref, entry.location, env).catch((error: unknown) => {
    throw new Error(`content "${entry.name}": ${(error as Error).message}`);
  });
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
