/**
 * The git a GitHub context needs on this machine: which repository a checkout is of, whether it is at the declared
 * `ref`, and a fresh clone. git's own configuration applies throughout (credential helpers, `url.<base>.insteadOf`), so
 * a private repository is reached the way the user's own `git clone` reaches it.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
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
 * Give `dir` what a fresh clone of github `repo` at `ref` (its default branch when unset) holds. The clone already
 * there is kept when it is exactly that: on the commit and branch the remote names now, nothing in its files changed,
 * added or ignored. Otherwise a new clone replaces it. When the remote cannot be reached, an untouched clone is kept
 * and the warning says so; a changed one cannot stand for a fresh clone, so the new clone is attempted and its failure
 * stops the start.
 */
export async function freshClone(
  repo: string,
  ref: string | undefined,
  dir: string,
): Promise<{ cloned: boolean; warning?: string }> {
  const current = existsSync(dir) ? untouched(dir) : undefined;
  if (current !== undefined) {
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

/** The clone in `dir` as a fresh one would show it, or undefined when anything in its files differs from its commit. */
function untouched(dir: string): Checkout | undefined {
  if (gitAnswer(["status", "--porcelain", "--ignored"], dir) !== "") return undefined;
  const commit = gitAnswer(["rev-parse", "HEAD"], dir);
  const branch = gitAnswer(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  return commit !== undefined && branch !== undefined ? { commit, branch } : undefined;
}

/**
 * What a fresh clone at `ref` would check out, asked of the remote: a branch by name, a tag detached at its commit,
 * the default branch when unset. A full commit needs no asking. Undefined when the remote has no such ref; rejects
 * when it cannot be reached.
 */
async function remoteCheckout(url: string, ref: string | undefined, cwd: string): Promise<Checkout | undefined> {
  if (ref !== undefined && FULL_COMMIT.test(ref)) return { commit: ref.toLowerCase(), branch: "HEAD" };
  const asked =
    ref === undefined
      ? ["--symref", "--end-of-options", url, "HEAD"]
      : ["--end-of-options", url, `refs/heads/${ref}`, `refs/tags/${ref}`];
  const refs = new Map<string, string>();
  let defaultBranch: string | undefined;
  for (const line of (await runGit(["ls-remote", ...asked], cwd)).split("\n")) {
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
 * Shallow: it is made afresh, not kept up to date.
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
