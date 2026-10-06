/**
 * A local stand-in for GitHub: bare repositories under a temporary directory, reached as `https://github.com/<repo>`
 * through git's own `url.<base>.insteadOf`, the way a user maps GitHub to SSH. Nothing in fastagent knows it is not
 * GitHub. The machine's own git configuration is shut out, so neither its rewrites nor its hooks reach a test.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";

const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A repository on the stand-in, with a working clone that commits and pushes to it. */
export interface StandInRepo {
  /** Commit `files` (relative path → content) on the current branch and push it; the new commit's hash. */
  commit(files: Record<string, string>): string;
  /** Switch the working clone to `branch`, creating it from the current commit when it is new. */
  branch(name: string): void;
  tag(name: string): void;
}

/** Stand GitHub in for the rest of the test (env stubbed: restore with `vi.unstubAllEnvs`). */
export function githubStandIn(): { repo(name: string): StandInRepo } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fa-github-")));
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", `url.file://${root}/remote/.insteadOf`);
  vi.stubEnv("GIT_CONFIG_VALUE_0", "https://github.com/");
  return {
    repo(name) {
      const bare = join(root, "remote", `${name}.git`);
      mkdirSync(dirname(bare), { recursive: true });
      git(root, "init", "-q", "--bare", "-b", "main", bare);
      const work = join(root, "work", name);
      mkdirSync(work, { recursive: true });
      git(work, "init", "-q", "-b", "main");
      git(work, "remote", "add", "origin", `https://github.com/${name}.git`);
      return {
        commit(files) {
          for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(work, path)), { recursive: true });
            writeFileSync(join(work, path), content);
          }
          git(work, "add", "-A");
          git(work, "commit", "-q", "-m", Object.keys(files).join(" "));
          git(work, "push", "-q", "origin", "HEAD");
          return git(work, "rev-parse", "HEAD");
        },
        branch(branch) {
          git(work, "checkout", "-q", "-B", branch);
        },
        tag(tag) {
          git(work, "tag", tag);
          git(work, "push", "-q", "origin", tag);
        },
      };
    },
  };
}
