/**
 * What a command's `<source>` adds (`init --content`, `fastagent content add`; docs/design/agent-cli.md §3), read the
 * same way by both: `github:owner/repo`, the root of a GitHub checkout, or any other directory.
 */
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { type ContentBinding, type ContentEntry, isGithubRepo } from "./declare.ts";
import { checkoutOf, githubRepoOf } from "./git.ts";

export interface SourceOptions {
  name?: string;
  /** A github entry's branch, tag or commit. */
  ref?: string;
  description?: string;
}

/**
 * A content entry to add, by name: the repository `context.json` declares for every instance, this machine's binding
 * in `context.local.json`, or both (a checkout of the declared repository). At least one.
 */
export interface ContentAddition {
  name: string;
  entry?: ContentEntry;
  binding?: ContentBinding;
}

/**
 * The addition `source` asks for, with what to tell the user about how it was read. `github:owner/repo` is a
 * repository fastagent clones. The root of a checkout whose `origin` is on GitHub is that repository, declared for
 * every instance and bound to this checkout here. Any other directory, a subdirectory of such a checkout included, is
 * bound on this machine alone. The name defaults to the repository's or the directory's.
 */
export function readContentSource(
  source: string,
  cwd: string,
  options: SourceOptions = {},
): { addition: ContentAddition; notes: string[] } {
  const treated = {
    ...(options.description !== undefined ? { description: options.description } : {}),
  };
  const ref = options.ref !== undefined ? { ref: options.ref } : {};
  const repoName = (repo: string) => repo.slice(repo.indexOf("/") + 1);
  if (source.startsWith("github:")) {
    const repo = source.slice("github:".length);
    if (!isGithubRepo(repo)) throw new Error(`${source} names no repository: write github:owner/repo`);
    return {
      addition: { name: options.name ?? repoName(repo), entry: { github: repo, ...ref, ...treated } },
      notes: [],
    };
  }
  const dir = resolve(cwd, source);
  const checkout = checkoutOf(dir);
  const repo = checkout?.origin === undefined ? undefined : githubRepoOf(checkout.origin);
  const atRoot = checkout !== undefined && realpathSync(dir) === realpathSync(checkout.root);
  if (repo !== undefined && atRoot) {
    const root = (checkout as { root: string }).root;
    return {
      addition: {
        name: options.name ?? repoName(repo),
        entry: { github: repo, ...ref, ...treated },
        binding: { path: root },
      },
      notes: [],
    };
  }
  if (options.ref !== undefined) {
    throw new Error(`--ref applies to a repository, and ${dir} is bound as a directory of this machine`);
  }
  const notes =
    repo !== undefined && !atRoot
      ? [`${dir} is in a checkout of github ${repo}: add github:${repo} for the whole repository`]
      : [];
  return { addition: { name: options.name ?? basename(dir), binding: { path: dir, ...treated } }, notes };
}
