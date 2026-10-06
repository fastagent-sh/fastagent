/**
 * Running git, and what ONE result means: an answer, a "no" (a non-zero exit: not a checkout, no such ref, not
 * ignored), or a git that cannot run at all. Every caller reads git through here, so a new kind of result is decided
 * once; each caller says only why it needed git, which is what a missing git is reported with.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

/** git is not on the PATH. Its message names what needed it: `git is not installed: <why>`. */
export class GitNotInstalled extends Error {}

/**
 * Never wait on a terminal prompt for a credential: a serving process has nobody to answer it, so git fails and says
 * why instead. Not covered by a test: it takes a remote that asks for a credential.
 */
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

const execGit = promisify(execFile);

/** git for one purpose, `why`: what a missing git is reported as needed for. */
export function gitFor(why: string) {
  const missing = () => new GitNotInstalled(`git is not installed: ${why}`);
  return {
    /**
     * git's answer in `cwd` (which must exist), or undefined when it answers with a non-zero exit. A git that cannot
     * run is an error.
     */
    answer(args: string[], cwd: string): string | undefined {
      try {
        return execFileSync("git", args, {
          cwd,
          env: gitEnv(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing();
        if (typeof (error as { status?: unknown }).status === "number") return undefined;
        throw error;
      }
    },
    /** Run git in `cwd`: its output, or its stderr as the error. */
    async run(args: string[], cwd: string): Promise<string> {
      try {
        return (await execGit("git", args, { cwd, env: gitEnv() })).stdout;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing();
        const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
        throw new Error(stderr || (error as Error).message);
      }
    },
  };
}
