/**
 * GitHub content against a local stand-in for GitHub (github-standin.ts): a repository is cloned into the instance's
 * working directory, and brought up to date at each start while that loses nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneContent } from "../src/content/resolve.ts";

import { git, githubStandIn } from "./github-standin.ts";
import { agent, resolveOne } from "./content-github-fixtures.ts";

afterEach(() => vi.unstubAllEnvs());

describe("github content: a clone is brought up to date in place, never over the agent's work", () => {
  it("a clone of another repository under the entry's name is refused, never removed", async () => {
    const github = githubStandIn();
    github.repo("acme/app").commit({ "README.md": "app\n" });
    const { agentDir } = await agent();
    const old = resolveOne(agentDir, { github: "acme/app", name: "work" });
    await cloneContent(old);
    await expect(cloneContent(resolveOne(agentDir, { github: "acme/other", name: "work" }))).rejects.toThrow(
      /content "work": .* is a clone of https:\/\/github\.com\/acme\/app\.git, not of github acme\/other: move it away/,
    );
    expect(readFileSync(join(old.location, "README.md"), "utf8")).toBe("app\n");
  });

  it("clones at the declared ref: a branch, a tag or a commit", async () => {
    const github = githubStandIn();
    const app = github.repo("acme/app");
    const first = app.commit({ "v.txt": "1" });
    app.tag("v1");
    app.commit({ "v.txt": "2" });
    app.branch("feat");
    const feat = app.commit({ "v.txt": "feat" });
    const { agentDir } = await agent();
    for (const [ref, expected, name] of [
      ["feat", feat, "a"],
      ["v1", first, "b"],
      [first, first, "c"],
    ] as const) {
      const entry = resolveOne(agentDir, { github: "acme/app", ref, name });
      expect(await cloneContent(entry)).toEqual({ outcome: "cloned" });
      expect(git(entry.location, "rev-parse", "HEAD")).toBe(expected);
    }
  });
});
