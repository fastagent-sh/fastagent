import { execFileSync } from "node:child_process";
import { hermeticGit } from "../../doubles/git-env.ts";
import { describe, expect, it } from "vitest";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freshDir, exists, withIdentity, cliInit } from "../../fixtures/init-fixtures.ts";

describe("init: scaffoldAgent", () => {
  it("makes the agent a git repository with the scaffold as its first commit, and says when it does not", async () => {
    const env = withIdentity;
    const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    const base = await realpath(await freshDir());

    expect(await cliInit(["init", "mine", "--no-install"], base, env)).toContain(
      "git: created a git repository, with the scaffold as its first commit",
    );
    const mine = join(base, "mine");
    expect(git(["rev-parse", "--show-toplevel"], mine)).toBe(mine);
    expect(git(["log", "--format=%s"], mine)).toBe("Create the agent with fastagent");
    expect(git(["status", "--porcelain"], mine)).toBe(""); // all of it committed
    expect(git(["ls-files"], mine).split("\n")).toEqual(
      expect.arrayContaining(["fastagent.config.ts", "SYSTEM.md", ".gitignore", ".secrets/.env.example"]),
    );

    // Inside a repository already: that one tracks the agent, and no second one hides its files from it.
    const outer = join(base, "agents");
    await mkdir(outer);
    git(["init", "--quiet"], outer);
    expect(await cliInit(["init", "inner", "--no-install"], outer, env)).toContain(
      `git: inside the git repository ${outer}: it tracks the agent, so none was created`,
    );
    expect(await exists(join(outer, "inner", ".git"))).toBe(false);
    // …unless it IGNORES the directory (a home directory kept in git with `*` ignored): then nothing tracks the
    // agent, so it gets its own.
    await writeFile(join(outer, ".gitignore"), "*\n");
    expect(await cliInit(["init", "ignored", "--no-install"], outer, env)).toContain(
      "git: created a git repository, with the scaffold as its first commit",
    );
    expect(git(["rev-parse", "--show-toplevel"], join(outer, "ignored"))).toBe(join(outer, "ignored"));

    // No identity to commit with: the repository stays, and the author is told to commit.
    const noIdentity = {
      ...hermeticGit,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
    };
    expect(await cliInit(["init", "anon", "--no-install"], base, noIdentity)).toMatch(
      /git: created a git repository, but its first commit failed \(.+\): commit the scaffold yourself/,
    );
    expect(await exists(join(base, "anon", ".git"))).toBe(true);

    // No git at all: said, and the agent is created anyway.
    const out = await cliInit(["init", "plain", "--no-install"], base, { ...env, PATH: "/nonexistent" });
    expect(out).toContain("git: git is not installed: no repository was created");
    expect(await exists(join(base, "plain", "fastagent.config.ts"))).toBe(true);
  });
});
