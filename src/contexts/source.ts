/**
 * What a command's `<source>` declares (`init --context`, `fastagent context add`; docs/design/agent-cli.md §3), read
 * the same way by both: `github:owner/repo`, a directory in a GitHub checkout, or any other directory.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type ContextDeclaration, isGithubRepo } from "./declare.ts";
import { checkoutOf, githubRepoOf } from "./git.ts";

export interface SourceOptions {
  readonly?: boolean;
  name?: string;
  /** A github context's branch, tag or commit. */
  ref?: string;
  /** The checkout that stands for a `github:` source on this machine. */
  local?: string;
}

/**
 * The declaration for `source`, with what to tell the user about how it was read. The root of a checkout whose
 * `origin` is on GitHub is that repository, with the checkout as its `local`. Any other directory is itself, `{ local }`,
 * a subdirectory of such a checkout included (the note names the repository form, which is the whole repository).
 * Paths are written absolute.
 */
export function declarationFor(
  source: string,
  cwd: string,
  options: SourceOptions = {},
): { declaration: ContextDeclaration; notes: string[] } {
  const treated = {
    ...(options.readonly ? { readonly: true } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
  };
  const ref = options.ref !== undefined ? { ref: options.ref } : {};
  if (source.startsWith("github:")) {
    const repo = source.slice("github:".length);
    if (!isGithubRepo(repo)) throw new Error(`${source} names no repository: write github:owner/repo`);
    const local = options.local === undefined ? {} : { local: resolve(cwd, options.local) };
    return { declaration: { github: repo, ...local, ...ref, ...treated }, notes: [] };
  }
  const dir = resolve(cwd, source);
  if (options.local !== undefined) throw new Error("--local applies to a github:owner/repo source");
  const checkout = checkoutOf(dir);
  const repo = checkout?.origin === undefined ? undefined : githubRepoOf(checkout.origin);
  const atRoot = checkout !== undefined && realpathSync(dir) === realpathSync(checkout.root);
  if (repo !== undefined && atRoot) {
    return { declaration: { github: repo, local: (checkout as { root: string }).root, ...ref, ...treated }, notes: [] };
  }
  if (options.ref !== undefined) {
    throw new Error(`--ref applies to a repository, and ${dir} is declared as a directory`);
  }
  const notes =
    repo !== undefined && !atRoot
      ? [`${dir} is in a checkout of github ${repo}: declare github:${repo} for the whole repository`]
      : [];
  return { declaration: { local: dir, ...treated }, notes };
}
