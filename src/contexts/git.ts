/**
 * The git a GitHub context needs on this machine: which repository a checkout is of, whether it is at the declared
 * `ref`, and a fresh clone. git's own configuration applies throughout (credential helpers, `url.<base>.insteadOf`), so
 * a private repository is reached the way the user's own `git clone` reaches it.
 */
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";

/**
 * Never wait on a terminal prompt for a credential: a serving process has nobody to answer it, so git fails and says
 * why instead. Not covered by a test: it takes a remote that asks for a credential.
 */
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

const NO_GIT = "git is not installed: a github context needs it on this machine";

/**
 * git's answer in `cwd` (which must exist), or undefined when it answers with a non-zero exit: not a checkout, no such
 * remote, no such ref. A git that cannot run is an error.
 */
function gitAnswer(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(NO_GIT);
    if (typeof (error as { status?: unknown }).status === "number") return undefined;
    throw error;
  }
}

const execGit = promisify(execFile);

/** Run git in `cwd`: its output, or its stderr as the error. */
async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    return (await execGit("git", args, { cwd, env: gitEnv() })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(NO_GIT);
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(stderr || (error as Error).message);
  }
}

/** The `owner/repo` a GitHub remote URL names, in any of its spellings (https, ssh, scp-like), or undefined. */
export function githubRepoOf(url: string): string | undefined {
  const match =
    /^(?:(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com\/|(?:[^@/:]+@)?github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** The URL fastagent clones github `repo` from. */
export function githubUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/**
 * The checkout `dir` is in: its root, and its `origin` as configured (not as `insteadOf` rewrites it). Undefined when
 * `dir` is not a directory inside a git checkout.
 */
export function checkoutOf(dir: string): { root: string; origin?: string } | undefined {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const root = gitAnswer(["rev-parse", "--show-toplevel"], dir);
  if (root === undefined) return undefined;
  const origin = gitAnswer(["config", "--get", "remote.origin.url"], root);
  return { root, ...(origin ? { origin } : {}) };
}

/**
 * Why the directory `local` cannot stand for github `repo` on this machine, or undefined when it can: it is the root
 * of a checkout whose `origin` is that repository.
 */
export function checkoutProblem(local: string, repo: string): string | undefined {
  if (!existsSync(local)) return "does not exist";
  const checkout = checkoutOf(local);
  if (checkout === undefined) return "is not a git checkout";
  if (realpathSync(checkout.root) !== realpathSync(local))
    return `is inside the checkout ${checkout.root}, not its root`;
  const of = checkout.origin === undefined ? undefined : githubRepoOf(checkout.origin);
  if (of?.toLowerCase() !== repo.toLowerCase()) {
    return `is a checkout of ${checkout.origin ?? "no origin"}, not of github ${repo}`;
  }
  return undefined;
}

/**
 * What to say when the checkout `dir` is not at `ref`, or undefined when it is: on that branch, or at the commit `ref`
 * names. FastAgent never moves a checkout the user owns, so this is said, not acted on.
 */
export function refNotice(dir: string, ref: string): string | undefined {
  const branch = gitAnswer(["symbolic-ref", "--quiet", "--short", "HEAD"], dir);
  if (branch === ref) return undefined;
  const head = gitAnswer(["rev-parse", "HEAD"], dir);
  const target = gitAnswer(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], dir);
  if (head !== undefined && head === target) {
    return undefined;
  }
  const at = branch ?? `a detached ${head?.slice(0, 7) ?? "HEAD"}`;
  return `the checkout is on ${at}, declared ${ref}; it is left as it is`;
}

/** A commit named in full: fetched by its hash, since `clone --branch` takes only a branch or a tag. */
const FULL_COMMIT = /^[0-9a-f]{40}$/i;

/** What a clone holds that a fresh clone would show: the commit checked out, and the branch (`HEAD` when detached). */
type Checkout = { commit: string; branch: string };

/**
 * Bring the clone of github `repo` at `ref` (its default branch when unset) in `dir` up to date, without ever losing
 * what was done in it: a clone is replaced only when replacing it loses nothing.
 * - None yet: cloned. A failure stops the start.
 * - Changes of its own (files changed, added or ignored, or commits since it was cloned): kept as it is, and the
 *   warning says it is not brought up to date. Merging it with the remote is git's, the agent's or the user's.
 * - Untouched: kept when it is on the commit and branch the remote names now, cloned again when the remote moved, and
 *   kept with a warning when the remote cannot be reached.
 */
export async function refreshClone(
  repo: string,
  ref: string | undefined,
  dir: string,
): Promise<{ cloned: boolean; warning?: string }> {
  // A library caller can hand this anything; git reads a leading "-" as an option, and no repository or ref has one
  // (a declaration with one is refused at load, declare.ts).
  if (repo.startsWith("-") || ref?.startsWith("-")) {
    throw new Error(`github ${repo}${ref !== undefined ? ` at ${ref}` : ""} would reach git as an option`);
  }
  if (existsSync(dir)) {
    const own = ownChanges(dir);
    if (own !== undefined) {
      return {
        cloned: false,
        warning: `the clone has ${own}: kept as it is, not brought up to date with github ${repo}`,
      };
    }
    const current = untouched(dir);
    let remote: Checkout | undefined;
    try {
      remote = await remoteCheckout(githubUrl(repo), ref, dirname(dir));
    } catch (error) {
      const reason = (error as Error).message.split("\n")[0];
      const made = statSync(dir).mtime.toISOString();
      return { cloned: false, warning: `could not reach github ${repo} (${reason}); using the clone made at ${made}` };
    }
    if (remote?.commit === current.commit && remote.branch === current.branch) return { cloned: false };
  }
  await cloneInto(repo, ref, dir);
  return { cloned: true };
}

/** Where a clone records the commit it was made at, inside its own `.git`: what tells a commit of the agent's apart. */
const CLONED_AT = "fastagent-cloned-at";

/**
 * What in the clone `dir` would be lost by replacing it, or undefined when nothing would: changed, added or ignored
 * files, or a commit other than the one it was cloned at. A clone that cannot say what it was cloned at is treated as
 * having changes, since replacing it is what cannot be undone.
 */
function ownChanges(dir: string): string | undefined {
  const status = gitAnswer(["status", "--porcelain", "--ignored"], dir);
  if (status === undefined) return "no git checkout in it";
  if (status !== "") return "changes in its files";
  const clonedAt = join(dir, ".git", CLONED_AT);
  if (!existsSync(clonedAt)) return "no record of the commit it was cloned at";
  return gitAnswer(["rev-parse", "HEAD"], dir) === readFileSync(clonedAt, "utf8").trim()
    ? undefined
    : "commits of its own";
}

/** The checkout of an untouched clone. */
function untouched(dir: string): Checkout {
  const commit = gitAnswer(["rev-parse", "HEAD"], dir);
  const branch = gitAnswer(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (commit === undefined || branch === undefined) throw new Error(`${dir} is not a git checkout`);
  return { commit, branch };
}

/**
 * What a fresh clone at `ref` would check out, asked of the remote: a branch by name, a tag detached at its commit,
 * the default branch when unset. A full commit needs no asking. Undefined when the remote has no such ref; rejects
 * when it cannot be reached.
 */
async function remoteCheckout(url: string, ref: string | undefined, cwd: string): Promise<Checkout | undefined> {
  if (ref !== undefined && FULL_COMMIT.test(ref)) return { commit: ref.toLowerCase(), branch: "HEAD" };
  // `--` before the operands, as for `clone`: nothing declared reaches git as an option.
  const listed =
    ref === undefined
      ? await runGit(["ls-remote", "--symref", "--", url, "HEAD"], cwd)
      : await runGit(["ls-remote", "--", url, `refs/heads/${ref}`, `refs/tags/${ref}`], cwd);
  const refs = new Map<string, string>();
  let defaultBranch: string | undefined;
  for (const line of listed.split("\n")) {
    const [left, name] = line.split("\t");
    if (left === undefined || name === undefined) continue;
    if (left.startsWith("ref: refs/heads/")) defaultBranch = left.slice("ref: refs/heads/".length);
    else refs.set(name, left);
  }
  if (ref === undefined) {
    const head = refs.get("HEAD");
    return head !== undefined && defaultBranch !== undefined ? { commit: head, branch: defaultBranch } : undefined;
  }
  const branch = refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return { commit: branch, branch: ref };
  const tag = refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`);
  return tag !== undefined ? { commit: tag, branch: "HEAD" } : undefined;
}

/**
 * Clone github `repo` at `ref` into `dir`, replacing whatever is there. The clone is built beside `dir` and renamed
 * into place under a lock in its parent, so another process reads the old clone or the new one, never half of either.
 * Shallow: a starting point to work from, not a history.
 */
async function cloneInto(repo: string, ref: string | undefined, dir: string): Promise<void> {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const next = join(parent, `.${basename(dir)}.next-${stamp}`);
  const old = join(parent, `.${basename(dir)}.old-${stamp}`);
  const url = githubUrl(repo);
  try {
    try {
      if (ref !== undefined && FULL_COMMIT.test(ref)) {
        await runGit(["init", "-q", next], parent);
        await runGit(["remote", "add", "origin", url], next);
        await runGit(["fetch", "-q", "--depth", "1", "--end-of-options", "origin", ref], next);
        await runGit(["checkout", "-q", "--detach", "FETCH_HEAD"], next);
      } else {
        // One token, and `--` before the operands: a declared value never reaches git as an option of its own.
        const branch = ref !== undefined ? [`--branch=${ref}`] : [];
        await runGit(["clone", "-q", "--depth", "1", ...branch, "--", url, next], parent);
      }
    } catch (error) {
      throw new Error(
        `could not clone github ${repo}${ref !== undefined ? ` at ${ref}` : ""}: ${(error as Error).message} — ` +
          `git's own credentials on this machine are used (a credential helper, or url.<base>.insteadOf for SSH)`,
      );
    }
    writeFileSync(join(next, ".git", CLONED_AT), await runGit(["rev-parse", "HEAD"], next));
    await replaceDirectory(next, dir, old);
  } finally {
    rmSync(next, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
}

/**
 * Put the directory `next` where `dir` is, moving what was there to `old`. Two renames, so another process doing the
 * same between them would find `dir` gone or taken: the lock in their parent makes the pair one step for every
 * process that replaces `dir` this way.
 */
export async function replaceDirectory(next: string, dir: string, old: string): Promise<void> {
  const release = await lockfile.lock(dirname(dir), {
    realpath: false,
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 5_000, randomize: true },
  });
  try {
    if (existsSync(dir)) renameSync(dir, old);
    renameSync(next, dir);
  } finally {
    await release();
  }
}
