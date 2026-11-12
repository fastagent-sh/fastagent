/**
 * What a command's `<source>` adds (`init --content`, `fastagent content add`), read the
 * same way by both: `github:owner/repo`, or a directory.
 */
import { basename, resolve } from "node:path";
import { type ContentEntry, isGithubRepo } from "./declare.ts";
import { checkoutOf, githubRepoOf } from "./git.ts";

export interface SourceOptions {
  name?: string;
  /** A github entry's branch, tag or commit. */
  ref?: string;
  description?: string;
}

/**
 * A content entry to add, by name. It is written to the instance's `fastagent.json`, or, with `program`, to the
 * program's `context.json`, which every instance of it reaches and so holds repositories only.
 */
export interface ContentAddition {
  name: string;
  entry: ContentEntry;
  program?: boolean;
}

/**
 * The addition `source` asks for, with what to tell the user about how it was read. `github:owner/repo` is a
 * repository fastagent clones. Any other source is a directory the agent works in as it is, a checkout of a GitHub
 * repository included, which is then said. The name defaults to the repository's or the directory's.
 */
export function readContentSource(
  source: string,
  cwd: string,
  options: SourceOptions = {},
): { addition: ContentAddition; notes: string[] } {
  const treated = options.description !== undefined ? { description: options.description } : {};
  const repoName = (repo: string) => repo.slice(repo.indexOf("/") + 1);
  if (source.startsWith("github:")) {
    const repo = source.slice("github:".length);
    if (!isGithubRepo(repo)) throw new Error(`${source} names no repository: write github:owner/repo`);
    const ref = options.ref !== undefined ? { ref: options.ref } : {};
    return {
      addition: { name: options.name ?? repoName(repo), entry: { github: repo, ...ref, ...treated } },
      notes: [],
    };
  }
  if (options.ref !== undefined) {
    throw new Error(`--ref applies to a repository, and ${resolve(cwd, source)} is a directory`);
  }
  const dir = resolve(cwd, source);
  const checkout = checkoutOf(dir);
  const repo = checkout?.origin === undefined ? undefined : githubRepoOf(checkout.origin);
  const notes =
    repo === undefined ? [] : [`${dir} is in a checkout of github ${repo}: add github:${repo} to have it cloned`];
  return { addition: { name: options.name ?? basename(dir), entry: { path: dir, ...treated } }, notes };
}
