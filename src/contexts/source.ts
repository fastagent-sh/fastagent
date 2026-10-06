/**
 * What a command's `<source>` declares (`init --context`, `fastagent context add`; docs/design/agent-cli.md §3), read
 * the same way by both: `github:owner/repo`, a directory in a GitHub checkout, or any other directory.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type ContextDeclaration, isGithubRepo } from "./declare.ts";
import { checkoutOf, githubRepoOf } from "./git.ts";

export interface SourceOptions {
  /** A host gets its own copy of a directory: its contents ship in an image, so never a default. */
  copy?: boolean;
  readonly?: boolean;
  name?: string;
  /** A github context's branch, tag or commit. */
  ref?: string;
  /** The checkout that stands for a `github:` source on this machine. */
  local?: string;
}

/**
 * The declaration for `source`, with what to tell the user about how it was read. A directory in a checkout whose
 * `origin` is on GitHub is that repository, with the checkout as its `local`: the whole repository, since a context
 * cannot be narrowed to a subdirectory yet. `copy` applies to a directory only: a host clones a repository. Paths are
 * written absolute.
 */
export function declarationFor(
  source: string,
  cwd: string,
  options: SourceOptions = {},
): { declaration: ContextDeclaration; notes: string[] } {
  const treated = {
    ...(options.ref !== undefined ? { ref: options.ref } : {}),
    ...(options.readonly ? { readonly: true } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
  };
  const cloned = (repo: string) =>
    options.copy ? [`github ${repo} is cloned on a host, so --copy does not apply`] : [];
  if (source.startsWith("github:")) {
    const repo = source.slice("github:".length);
    if (!isGithubRepo(repo)) throw new Error(`${source} names no repository: write github:owner/repo`);
    const local = options.local === undefined ? {} : { local: resolve(cwd, options.local) };
    return { declaration: { github: repo, ...local, ...treated }, notes: cloned(repo) };
  }
  const dir = resolve(cwd, source);
  if (options.local !== undefined) throw new Error("--local applies to a github:owner/repo source");
  const checkout = checkoutOf(dir);
  const repo = checkout?.origin === undefined ? undefined : githubRepoOf(checkout.origin);
  if (checkout !== undefined && repo !== undefined) {
    const whole =
      realpathSync(dir) === realpathSync(checkout.root)
        ? []
        : [`${dir} is inside the checkout ${checkout.root}: the context is the whole repository, github ${repo}`];
    return { declaration: { github: repo, local: checkout.root, ...treated }, notes: [...whole, ...cloned(repo)] };
  }
  if (options.ref !== undefined)
    throw new Error(`--ref applies to a github context, and ${dir} is not a GitHub checkout`);
  return { declaration: { local: dir, ...(options.copy ? { copy: true } : {}), ...treated }, notes: [] };
}
