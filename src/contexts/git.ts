/**
 * The git a GitHub context needs on this machine: which repository a checkout is of, whether it is at the declared
 * `ref`, and a clone, made or brought up to date in place. git's own configuration applies throughout (credential helpers, `url.<base>.insteadOf`), so
 * a private repository is reached the way the user's own `git clone` reaches it.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

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
function githubUrl(repo: string): string {
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

/**
 * git aborts a transfer that moves under 1 KB/s for 15 seconds, so a network that drops packets silently does not hold
 * a start until TCP gives up, while a large transfer that is moving is left alone. http(s) only. Not covered by a
 * test: it takes a remote that stops answering.
 */
const SLOW_NETWORK = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=15"];

/**
 * The ref that holds the commit a clone pinned to a commit was last put on. Fetching a commit by its hash creates no
 * ref, and without one every commit of a detached clone would look like the agent's own.
 */
const PINNED = "refs/remotes/origin/pinned";

/**
 * The credential a clone of fastagent's reaches GitHub with when git has none of its own: `GITHUB_TOKEN`, read from
 * the environment each time git asks, so the token is never written to disk. Set in the clone's own config, so the
 * agent's `git push` there uses it too. git asks its own helpers first (a credential manager on a laptop), then this
 * one, which answers nothing when the variable is unset.
 */
const TOKEN_HELPER =
  '!f() { test "$1" = get && test -n "$GITHUB_TOKEN" && printf "username=x-access-token\\npassword=%s\\n" "$GITHUB_TOKEN"; }; f';
const HELPER_KEY = "credential.https://github.com.helper";

/**
 * What a start did with a clone: made it, moved it to what the remote has now, found it there already, or kept it as
 * it is, for the `reason` given (git refused to touch the agent's work, or the remote could not be reached).
 */
export type CloneOutcome = { outcome: "cloned" | "updated" | "current" } | { outcome: "kept"; reason: string };

/**
 * Clone github `repo` at `ref` (its default branch when unset) into `dir`, or bring the clone there up to date IN
 * PLACE, by git's own rules: a fetch, then a fast-forward of the branch it is on, or a checkout of the tag or commit
 * it is pinned to. git refuses whatever would overwrite the agent's work (a changed file the update touches, an
 * untracked file it would replace, commits the remote does not have), and the clone is then kept as it is, with
 * git's reason; so it is when the fetch fails, or when the clone is on another branch than declared. Nothing is
 * deleted: the agent's branches, stashes and the changes an update does not touch stay where they are.
 * - None yet: cloned beside it and renamed into place. A first clone that fails stops the start.
 * - A clone of another repository there (the context was renamed or redeclared): refused, naming it.
 */
export async function refreshClone(repo: string, ref: string | undefined, dir: string): Promise<CloneOutcome> {
  // A library caller can hand this anything; git reads a leading "-" as an option, and no repository or ref has one
  // (a declaration with one is refused at load, declare.ts).
  if (repo.startsWith("-") || ref?.startsWith("-")) {
    throw new Error(`github ${repo}${ref !== undefined ? ` at ${ref}` : ""} would reach git as an option`);
  }
  if (!existsSync(dir)) return cloneInto(repo, ref, dir);
  const origin = gitAnswer(["config", "--get", "remote.origin.url"], dir);
  if (origin === undefined || githubRepoOf(origin)?.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(
      `${dir} is a clone of ${origin ?? "no repository"}, not of github ${repo}: move it away (push what should last ` +
        `first), then start again`,
    );
  }
  const kept = (reason: string): CloneOutcome => ({ outcome: "kept", reason });
  const branch = gitAnswer(["symbolic-ref", "--quiet", "--short", "HEAD"], dir);
  const declared =
    ref ?? gitAnswer(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], dir)?.replace(/^origin\//, "");
  if (branch !== undefined && branch !== declared) {
    return kept(`it is on branch ${branch}, declared ${ref ?? `the default branch${declared ? `, ${declared}` : ""}`}`);
  }
  if (branch === undefined) {
    if (ref === undefined) return kept("it is on a detached commit, declared the default branch");
    // Moving a detached HEAD away from commits of its own would leave them held by nothing.
    if (gitAnswer(["rev-list", "--count", "HEAD", "--not", "--branches", "--tags", "--remotes"], dir) !== "0") {
      return kept("it has commits no branch or tag holds");
    }
  }
  // A clone made before the helper existed, or whose config was edited, gets it back.
  await runGit(["config", HELPER_KEY, TOKEN_HELPER], dir);
  const before = gitAnswer(["rev-parse", "HEAD"], dir);
  // Pinned to a commit and on it: nothing a remote says can change that.
  if (ref !== undefined && FULL_COMMIT.test(ref) && before === ref.toLowerCase()) return { outcome: "current" };
  try {
    await runGit([...SLOW_NETWORK, "fetch", "-q", "--end-of-options", "origin", branch ?? (ref as string)], dir);
  } catch (error) {
    return kept(`could not reach github ${repo}: ${gitReason(error)}`);
  }
  if (gitAnswer(["rev-parse", "FETCH_HEAD^{commit}"], dir) === before) return { outcome: "current" };
  try {
    if (branch !== undefined) {
      await runGit(["merge", "-q", "--ff-only", "FETCH_HEAD"], dir);
    } else {
      await runGit(["checkout", "-q", "--detach", "FETCH_HEAD"], dir);
      await runGit(["update-ref", PINNED, "HEAD"], dir);
    }
  } catch (error) {
    return kept(`git would not update it: ${gitReason(error)}`);
  }
  return { outcome: "updated" };
}

/** git's own words for a refusal, without its hints. */
function gitReason(error: unknown): string {
  return (error as Error).message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("hint:"))
    .join(" ");
}

/**
 * Clone github `repo` at `ref` into `dir`, which does not exist: built beside it and renamed into place, so another
 * process reads no clone or a whole one. When another process put its own there first, that one stands and this one
 * is discarded. Shallow: a starting point to work from; a later fetch brings the history an update needs.
 */
async function cloneInto(repo: string, ref: string | undefined, dir: string): Promise<CloneOutcome> {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const next = join(parent, `.${basename(dir)}.next-${process.pid}-${Date.now()}`);
  const url = githubUrl(repo);
  try {
    try {
      if (ref !== undefined && FULL_COMMIT.test(ref)) {
        await runGit(["init", "-q", next], parent);
        await runGit(["config", HELPER_KEY, TOKEN_HELPER], next);
        await runGit(["remote", "add", "origin", url], next);
        await runGit([...SLOW_NETWORK, "fetch", "-q", "--depth", "1", "--end-of-options", "origin", ref], next);
        await runGit(["checkout", "-q", "--detach", "FETCH_HEAD"], next);
        await runGit(["update-ref", PINNED, "HEAD"], next);
      } else {
        // One token, and `--` before the operands: a declared value never reaches git as an option of its own.
        const branch = ref !== undefined ? [`--branch=${ref}`] : [];
        await runGit(
          [
            ...SLOW_NETWORK,
            "clone",
            "-q",
            "--depth",
            "1",
            "--config",
            `${HELPER_KEY}=${TOKEN_HELPER}`,
            ...branch,
            "--",
            url,
            next,
          ],
          parent,
        );
      }
    } catch (error) {
      throw new Error(
        `could not clone github ${repo}${ref !== undefined ? ` at ${ref}` : ""}: ${(error as Error).message} — ` +
          `git's own credentials on this machine are used (a credential helper, or url.<base>.insteadOf for SSH)`,
      );
    }
    try {
      renameSync(next, dir);
    } catch (error) {
      // Another process's clone got there first (renaming onto a directory that is not empty fails): it stands.
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "ENOTEMPTY" || code === "EEXIST") && existsSync(dir)) return { outcome: "current" };
      throw error;
    }
    return { outcome: "cloned" };
  } finally {
    rmSync(next, { recursive: true, force: true });
  }
}
