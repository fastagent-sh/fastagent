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

/** Run git in `cwd`: its output, or its stderr as the error. A `timeoutMs` that runs out is an error too. */
async function runGit(args: string[], cwd: string, timeoutMs?: number): Promise<string> {
  try {
    return (await execGit("git", args, { cwd, env: gitEnv(), ...(timeoutMs ? { timeout: timeoutMs } : {}) })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(NO_GIT);
    if ((error as { killed?: boolean }).killed) throw new Error(`no answer within ${(timeoutMs ?? 0) / 1000}s`);
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
 * - A clone of another repository (the context was renamed or redeclared): replaced when it holds nothing of the
 *   agent's, refused, naming it, when it does.
 * - Changes of its own (files changed, added or ignored, a commit, branch, tag or stash since it was cloned): kept as
 *   it is, and the warning says it is not brought up to date. Merging it with the remote is git's, the agent's or the
 *   user's.
 * - Untouched: kept when it is on the commit and branch the remote names now, cloned again when the remote moved, and
 *   kept with a warning when the remote cannot be reached. Asked again under the lock that replaces it, since the
 *   agent of another process may have written to it while the new clone was made.
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
  const kept = (own: string) => ({
    cloned: false,
    warning: `the clone has ${own}: kept as it is, not brought up to date with github ${repo}`,
  });
  if (existsSync(dir) && isCloneOf(dir, repo)) {
    const own = ownChanges(dir);
    if (own !== undefined) return kept(own);
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
  } else if (existsSync(dir)) {
    // Its name now stands for another repository. Replaced only when nothing in it is the agent's: the agent was told
    // it is a clone of the repository it came from, and its work there must not vanish under another name.
    const own = ownChanges(dir);
    if (own !== undefined) {
      const origin = gitAnswer(["config", "--get", "remote.origin.url"], dir) ?? "no repository";
      throw new Error(
        `${dir} is a clone of ${origin}, not of github ${repo}, and has ${own}: move it away (push what should last ` +
          `first), then start again`,
      );
    }
  }
  const unreplaced = await cloneInto(repo, ref, dir, () => (existsSync(dir) ? ownChanges(dir) : undefined));
  return unreplaced === undefined ? { cloned: true } : kept(unreplaced);
}

/** Whether `dir` is a clone of github `repo`, by its `origin`. */
function isCloneOf(dir: string, repo: string): boolean {
  const origin = gitAnswer(["config", "--get", "remote.origin.url"], dir);
  return origin !== undefined && githubRepoOf(origin)?.toLowerCase() === repo.toLowerCase();
}

/**
 * Where a clone records what it held when it was made, inside its own `.git`: HEAD and every branch, tag and stash.
 * What differs from it later is the agent's.
 */
const CLONED_AS = "fastagent-cloned-as";

/** HEAD and the refs a replacement would drop with the directory: branches, tags, the stash. */
function refsOf(dir: string): string | undefined {
  const head = gitAnswer(["rev-parse", "HEAD"], dir);
  const refs = gitAnswer(
    ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags", "refs/stash"],
    dir,
  );
  return head === undefined || refs === undefined ? undefined : `HEAD ${head}\n${refs}`;
}

/**
 * What in the clone `dir` would be lost by replacing it, or undefined when nothing would: changed, added or ignored
 * files, or a HEAD, branch, tag or stash other than it was cloned with. A clone that cannot say what it was cloned
 * with is treated as having changes, since replacing it is what cannot be undone.
 */
function ownChanges(dir: string): string | undefined {
  const status = gitAnswer(["status", "--porcelain", "--ignored"], dir);
  if (status === undefined) return "no git checkout in it";
  if (status !== "") return "changes in its files";
  const record = join(dir, ".git", CLONED_AS);
  if (!existsSync(record)) return "no record of what it was cloned with";
  return refsOf(dir) === readFileSync(record, "utf8") ? undefined : "commits, branches, tags or a stash of its own";
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
      ? await runGit(["ls-remote", "--symref", "--", url, "HEAD"], cwd, LS_REMOTE_TIMEOUT_MS)
      : await runGit(["ls-remote", "--", url, `refs/heads/${ref}`, `refs/tags/${ref}`], cwd, LS_REMOTE_TIMEOUT_MS);
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
 * How long a start waits to hear whether the remote moved before it uses the clone there: a network that drops packets
 * silently would otherwise hold it until TCP gives up. Not covered by a test: it takes a remote that never answers.
 */
const LS_REMOTE_TIMEOUT_MS = 15_000;

/**
 * Clone github `repo` at `ref` into `dir`, replacing whatever is there unless `keep` names a reason not to, asked
 * under the lock that replaces it: that reason, when it kept it. The clone is built beside `dir` and renamed into
 * place under a lock in its parent, so another process reads the old clone or the new one, never half of either.
 * Shallow: a starting point to work from, not a history.
 */
async function cloneInto(
  repo: string,
  ref: string | undefined,
  dir: string,
  keep: () => string | undefined,
): Promise<string | undefined> {
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
    writeFileSync(join(next, ".git", CLONED_AS), refsOf(next) ?? "");
    return await replaceDirectory(next, dir, old, keep);
  } finally {
    rmSync(next, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
}

/**
 * Put the directory `next` where `dir` is, moving what was there to `old`, unless `keep` (asked under the lock) names
 * a reason to keep it: that reason, when it did. Two renames, so another process doing the same between them would
 * find `dir` gone or taken: the lock in their parent makes the pair one step for every process that replaces `dir`
 * this way.
 */
export async function replaceDirectory(
  next: string,
  dir: string,
  old: string,
  keep: () => string | undefined = () => undefined,
): Promise<string | undefined> {
  const release = await lockfile.lock(dirname(dir), {
    realpath: false,
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 5_000, randomize: true },
  });
  try {
    const reason = keep();
    if (reason !== undefined) return reason;
    if (existsSync(dir)) renameSync(dir, old);
    renameSync(next, dir);
    return undefined;
  } finally {
    await release();
  }
}
